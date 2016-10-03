import { Emitter, Disposable } from 'event-kit'
import { shell } from 'electron'
import * as Path from 'path'
import {
  IRepositoryState,
  IHistoryState,
  IAppState,
  RepositorySection,
  IChangesState,
  Popup,
  IBranchesState,
  IAppError,
  PossibleSelections,
  PopupType,
  SelectionType,
} from '../app-state'
import { User } from '../../models/user'
import { Repository } from '../../models/repository'
import { GitHubRepository } from '../../models/github-repository'
import { FileChange, WorkingDirectoryStatus, WorkingDirectoryFileChange, FileStatus } from '../../models/status'
import { DiffSelectionType } from '../../models/diff'
import { matchGitHubRepository } from '../../lib/repository-matching'
import { API,  getUserForEndpoint, IAPIUser } from '../../lib/api'
import { LocalGitOperations, Commit, Branch } from '../local-git-operations'
import { CloningRepository, CloningRepositoriesStore } from './cloning-repositories-store'
import { IGitHubUser } from './github-user-database'
import { GitHubUserStore } from './github-user-store'
import { EmojiStore } from './emoji-store'
import { GitStore } from './git-store'

const LastSelectedRepositoryIDKey = 'last-selected-repository-id'

/** File statuses which indicate the file exists on disk. */
const OnDiskStatuses = new Set([
  FileStatus.New,
  FileStatus.Modified,
  FileStatus.Renamed,
  FileStatus.Conflicted,
  FileStatus.Unknown,
])

/**
 * File statuses which indicate the file has previously been committed to the
 * repository.
 */
const CommittedStatuses = new Set([
  FileStatus.Modified,
  FileStatus.Deleted,
  FileStatus.Renamed,
  FileStatus.Conflicted,
  FileStatus.Unknown,
])

export class AppStore {
  private emitter = new Emitter()

  private users: ReadonlyArray<User> = new Array<User>()
  private repositories: ReadonlyArray<Repository> = new Array<Repository>()

  private selectedRepository: Repository | CloningRepository | null = null
  private repositoryState = new Map<number, IRepositoryState>()
  private loading = false

  private currentPopup: Popup | null = null

  private errors: ReadonlyArray<IAppError> = new Array<IAppError>()

  private emitQueued = false

  private readonly gitHubUserStore: GitHubUserStore

  private readonly cloningRepositoriesStore: CloningRepositoriesStore

  private readonly emojiStore: EmojiStore

  /** GitStores keyed by their associated Repository ID. */
  private readonly gitStores = new Map<number, GitStore>()

  public constructor(gitHubUserStore: GitHubUserStore, cloningRepositoriesStore: CloningRepositoriesStore, emojiStore: EmojiStore) {
    this.gitHubUserStore = gitHubUserStore
    this.cloningRepositoriesStore = cloningRepositoriesStore
    this.emojiStore = emojiStore

    this.gitHubUserStore.onDidUpdate(() => {
      this.emitUpdate()
    })

    this.cloningRepositoriesStore.onDidUpdate(() => {
      this.emitUpdate()
    })

    this.emojiStore.read().then(() => this.emitUpdate())
  }

  private emitUpdate() {
    if (this.emitQueued) { return }

    this.emitQueued = true

    window.requestAnimationFrame(() => {
      this.emitter.emit('did-update', this.getState())
      this.emitQueued = false
    })
  }

  public onDidUpdate(fn: (state: IAppState) => void): Disposable {
    return this.emitter.on('did-update', fn)
  }

  private getInitialRepositoryState(): IRepositoryState {
    return {
      historyState: {
        selection: {
          sha: null,
          file: null,
        },
        changedFiles: new Array<FileChange>(),
        history: new Array<string>(),
        diff: null,
      },
      changesState: {
        workingDirectory: new WorkingDirectoryStatus(new Array<WorkingDirectoryFileChange>(), true),
        selectedFile: null,
        diff: null,
      },
      selectedSection: RepositorySection.Changes,
      branchesState: {
        currentBranch: null,
        defaultBranch: null,
        allBranches: new Array<Branch>(),
        recentBranches: new Array<Branch>(),
      },
      committerEmail: null,
      gitHubUsers: new Map<string, IGitHubUser>(),
      commits: new Map<string, Commit>(),
    }
  }

  /** Get the state for the repository. */
  public getRepositoryState(repository: Repository): IRepositoryState {
    let state = this.repositoryState.get(repository.id)
    if (state) {
      const gitHubUsers = this.gitHubUserStore.getUsersForRepository(repository) || new Map<string, IGitHubUser>()
      return {
        historyState: state.historyState,
        changesState: state.changesState,
        selectedSection: state.selectedSection,
        branchesState: state.branchesState,
        committerEmail: state.committerEmail,
        gitHubUsers,
        commits: state.commits,
      }
    }

    state = this.getInitialRepositoryState()
    this.repositoryState.set(repository.id, state)
    return state
  }

  private updateRepositoryState(repository: Repository, fn: (state: IRepositoryState) => IRepositoryState) {
    const currentState = this.getRepositoryState(repository)
    this.repositoryState.set(repository.id, fn(currentState))
  }

  private updateHistoryState(repository: Repository, fn: (historyState: IHistoryState) => IHistoryState) {
    this.updateRepositoryState(repository, state => {
      const historyState = fn(state.historyState)
      return {
        historyState,
        changesState: state.changesState,
        selectedSection: state.selectedSection,
        committerEmail: state.committerEmail,
        branchesState: state.branchesState,
        gitHubUsers: state.gitHubUsers,
        commits: state.commits,
      }
    })
  }

  private updateChangesState(repository: Repository, fn: (changesState: IChangesState) => IChangesState) {
    this.updateRepositoryState(repository, state => {
      const changesState = fn(state.changesState)
      return {
        historyState: state.historyState,
        changesState,
        selectedSection: state.selectedSection,
        committerEmail: state.committerEmail,
        branchesState: state.branchesState,
        gitHubUsers: state.gitHubUsers,
        commits: state.commits,
      }
    })
  }

  private updateBranchesState(repository: Repository, fn: (branchesState: IBranchesState) => IBranchesState) {
    this.updateRepositoryState(repository, state => {
      const branchesState = fn(state.branchesState)
      return {
        historyState: state.historyState,
        changesState: state.changesState,
        selectedSection: state.selectedSection,
        committerEmail: state.committerEmail,
        branchesState,
        gitHubUsers: state.gitHubUsers,
        commits: state.commits,
      }
    })
  }

  private getSelectedState(): PossibleSelections | null {
    const repository = this.selectedRepository
    if (!repository) { return null }

    if (repository instanceof Repository) {
      return {
        type: SelectionType.Repository,
        repository,
        state: this.getRepositoryState(repository),
      }
    } else {
      const cloningState = this.cloningRepositoriesStore.getRepositoryState(repository)
      if (!cloningState) { return null }

      return {
        type: SelectionType.CloningRepository,
        repository,
        state: cloningState,
      }
    }
  }

  public getState(): IAppState {
    return {
      users: this.users,
      repositories: [
        ...this.repositories,
        ...this.cloningRepositoriesStore.repositories,
      ],
      selectedState: this.getSelectedState(),
      currentPopup: this.currentPopup,
      errors: this.errors,
      loading: this.loading,
      emoji: this.emojiStore.emoji,
    }
  }

  private onGitStoreUpdated(repository: Repository, gitStore: GitStore) {
    this.updateHistoryState(repository, state => {
      return {
        history: gitStore.history,
        selection: state.selection,
        changedFiles: state.changedFiles,
        diff: state.diff,
      }
    })

    this.updateBranchesState(repository, state => {
      return {
        currentBranch: gitStore.currentBranch,
        defaultBranch: gitStore.defaultBranch,
        allBranches: gitStore.allBranches,
        recentBranches: gitStore.recentBranches,
      }
    })

    this.updateRepositoryState(repository, state => {
      return {
        historyState: state.historyState,
        changesState: state.changesState,
        selectedSection: state.selectedSection,
        committerEmail: state.committerEmail,
        branchesState: state.branchesState,
        gitHubUsers: state.gitHubUsers,
        commits: gitStore.commits,
      }
    })

    this.emitUpdate()
  }

  private onGitStoreLoadedCommits(repository: Repository, commits: ReadonlyArray<Commit>) {
    for (const commit of commits) {
      this.gitHubUserStore._loadAndCacheUser(this.users, repository, commit.sha, commit.authorEmail)
    }
  }

  private getGitStore(repository: Repository): GitStore {
    let gitStore = this.gitStores.get(repository.id)
    if (!gitStore) {
      gitStore = new GitStore(repository)
      gitStore.onDidUpdate(() => this.onGitStoreUpdated(repository, gitStore!))
      gitStore.onDidLoadNewCommits(commits => this.onGitStoreLoadedCommits(repository, commits))

      this.gitStores.set(repository.id, gitStore)
    }

    return gitStore
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _loadHistory(repository: Repository): Promise<void> {
    const gitStore = this.getGitStore(repository)
    await gitStore.loadHistory()

    const state = this.getRepositoryState(repository).historyState
    let newSelection = state.selection
    const history = state.history
    const selectedSHA = state.selection.sha
    if (selectedSHA) {
      const index = history.findIndex(sha => sha === selectedSHA)
      // Our selected SHA disappeared, so clear the selection.
      if (index < 0) {
        newSelection = {
          sha: null,
          file: null,
        }
      }
    }

    if (!newSelection.sha && history.length > 0) {
      this._changeHistoryCommitSelection(repository, history[0])
      this._loadChangedFilesForCurrentSelection(repository)
    }

    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _loadNextHistoryBatch(repository: Repository): Promise<void> {
    const gitStore = this.getGitStore(repository)
    return gitStore.loadNextHistoryBatch()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _loadChangedFilesForCurrentSelection(repository: Repository): Promise<void> {
    const state = this.getRepositoryState(repository)
    const selection = state.historyState.selection
    const currentSHA = selection.sha
    if (!currentSHA) { return }

    const changedFiles = await LocalGitOperations.getChangedFiles(repository, currentSHA)

    // The selection could have changed between when we started loading the
    // changed files and we finished. We might wanna store the changed files per
    // SHA/path.
    if (currentSHA !== state.historyState.selection.sha) {
      return
    }

    this.updateHistoryState(repository, state => {
      return {
        history: state.history,
        selection,
        changedFiles,
        diff: state.diff,
      }
    })
    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _changeHistoryCommitSelection(repository: Repository, sha: string): Promise<void> {
    this.updateHistoryState(repository, state => {
      const commitChanged = state.selection.sha !== sha
      const changedFiles = commitChanged ? new Array<FileChange>() : state.changedFiles
      const file = commitChanged ? null : state.selection.file

      return {
        history: state.history,
        selection: { sha, file },
        changedFiles,
        diff: null,
      }
    })
    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _changeHistoryFileSelection(repository: Repository, file: FileChange): Promise<void> {

    this.updateHistoryState(repository, state => {
      return {
        history: state.history,
        selection: { sha: state.selection.sha, file },
        changedFiles: state.changedFiles,
        diff: null,
      }
    })
    this.emitUpdate()

    const stateBeforeLoad = this.getRepositoryState(repository)

    const sha = stateBeforeLoad.historyState.selection.sha
    const commit = sha ? (stateBeforeLoad.commits.get(sha) || null) : null

    if (!commit) {
      throw new Error(`Could not find commit for sha ${sha}`)
    }

    const diff = await LocalGitOperations.getCommitDiff(repository, file, commit)

    const stateAfterLoad = this.getRepositoryState(repository)

    // A whole bunch of things could have happened since we initiated the diff load
    if (stateAfterLoad.historyState.selection.sha !== stateBeforeLoad.historyState.selection.sha) { return }
    if (!stateAfterLoad.historyState.selection.file) { return }
    if (stateAfterLoad.historyState.selection.file.id !== file.id) { return }

    this.updateHistoryState(repository, state => {
      return {
        history: state.history,
        selection: { sha: state.selection.sha, file },
        changedFiles: state.changedFiles,
        diff,
      }
    })

    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _selectRepository(repository: Repository | CloningRepository | null): Promise<void> {
    this.selectedRepository = repository
    this.emitUpdate()

    if (!repository) { return Promise.resolve() }

    if (repository instanceof Repository) {
      localStorage.setItem(LastSelectedRepositoryIDKey, repository.id.toString())
      return this._refreshRepository(repository)
    } else {
      return Promise.resolve()
    }
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _loadFromSharedProcess(users: ReadonlyArray<User>, repositories: ReadonlyArray<Repository>) {
    this.users = users
    this.repositories = repositories
    this.loading = this.repositories.length === 0 && this.users.length === 0

    for (const user of users) {
      // In theory a user should _always_ have an array of emails (even if it's
      // empty). But in practice, if the user had run old dev builds this may
      // not be the case. So for now we need to guard this. We should remove
      // this check in the not too distant future.
      // @joshaber (August 10, 2016)
      if (!user.emails) { break }

      const gitUsers = user.emails.map(email => {
        return {
          endpoint: user.endpoint,
          email,
          login: user.login,
          avatarURL: user.avatarURL,
        }
      })

      for (const user of gitUsers) {
        this.gitHubUserStore.cacheUser(user)
      }
    }

    const selectedRepository = this.selectedRepository
    let newSelectedRepository: Repository | CloningRepository | null = this.selectedRepository
    if (selectedRepository) {
      const i = this.repositories.findIndex(r => {
        return selectedRepository.constructor === r.constructor && r.id === selectedRepository.id
      })
      if (i === -1) {
        newSelectedRepository = null
      }
    }

    if (!this.selectedRepository && this.repositories.length > 0) {
      const lastSelectedID = parseInt(localStorage.getItem(LastSelectedRepositoryIDKey) || '', 10)
      if (lastSelectedID && !isNaN(lastSelectedID)) {
        newSelectedRepository = this.repositories.find(r => r.id === lastSelectedID) || null
      }

      if (!newSelectedRepository) {
        newSelectedRepository = this.repositories[0]
      }
    }

    if (newSelectedRepository !== selectedRepository) {
      this._selectRepository(newSelectedRepository)
    }

    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _loadStatus(repository: Repository, clearPartialState: boolean = false): Promise<void> {
    let workingDirectory = new WorkingDirectoryStatus(new Array<WorkingDirectoryFileChange>(), true)
    try {
      const status = await LocalGitOperations.getStatus(repository)
      workingDirectory = status.workingDirectory
    } catch (e) {
      console.error(e)
    }

    let selectedFile: WorkingDirectoryFileChange | null = null
    this.updateChangesState(repository, state => {

      // Populate a map for all files in the current working directory state
      const filesByID = new Map<string, WorkingDirectoryFileChange>()
      state.workingDirectory.files.forEach(f => filesByID.set(f.id, f))

      // Attempt to preserve the selection state for each file in the new
      // working directory state by looking at the current files
      const mergedFiles = workingDirectory.files.map(file => {
        const existingFile = filesByID.get(file.id)
        if (existingFile) {

          if (clearPartialState) {
            if (existingFile.selection.getSelectionType() === DiffSelectionType.Partial) {
              return file.withIncludeAll(false)
            }
          }

          return file.withSelection(existingFile.selection)
        } else {
          return file
        }
      })

      const includeAll = this.getIncludeAllState(mergedFiles)

      // Try to find the currently selected file among the files
      // in the new working directory state. Matching by id is
      // different from matching by path since id includes the
      // change type (new, modified, deleted etc)
      if (state.selectedFile) {
        selectedFile = mergedFiles.find(f => f.id === state.selectedFile!.id) || null
      }

      const fileSelectionChanged = !!selectedFile

      if (!selectedFile && mergedFiles.length) {
        selectedFile = mergedFiles[0]
      }

      return {
        workingDirectory: new WorkingDirectoryStatus(mergedFiles, includeAll),
        selectedFile: selectedFile || null,
        // The file selection could have changed if the previously selected
        // file is no longer selectable (it was reverted or committed) but
        // if it hasn't changed we can reuse the diff
        diff: fileSelectionChanged ? null : state.diff,
      }
    })
    this.emitUpdate()

    this._changeChangesSelection(repository, selectedFile)
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _changeRepositorySection(repository: Repository, section: RepositorySection): Promise<void> {
    this.updateRepositoryState(repository, state => {
      return {
        historyState: state.historyState,
        changesState: state.changesState,
        selectedSection: section,
        committerEmail: state.committerEmail,
        branchesState: state.branchesState,
        gitHubUsers: state.gitHubUsers,
        commits: state.commits,
      }
    })
    this.emitUpdate()

    if (section === RepositorySection.History) {
      return this._loadHistory(repository)
    } else if (section === RepositorySection.Changes) {
      return this._loadStatus(repository)
    }
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _changeChangesSelection(repository: Repository, selectedFile: WorkingDirectoryFileChange | null): Promise<void> {
    this.updateChangesState(repository, state => {
      return {
        workingDirectory: state.workingDirectory,
        selectedFile,
        diff: null,
      }
    })
    this.emitUpdate()

    if (!selectedFile) { return }

    const diff = await LocalGitOperations.getWorkingDirectoryDiff(repository, selectedFile)
    const stateAfterLoad = this.getRepositoryState(repository)

    // A whole bunch of things could have happened since we initiated the diff load
    if (!stateAfterLoad.changesState.selectedFile) { return }
    if (stateAfterLoad.changesState.selectedFile.id !== selectedFile.id) { return }

    const diffSelection = selectedFile.selection
    const selectionType = diffSelection.getSelectionType()

    if (selectionType === DiffSelectionType.Partial) {
      diffSelection.selectedLines.forEach((value, index) => {
        const hunk = diff.diffHunkForIndex(index)
        if (hunk) {
          const relativeIndex = index - hunk.unifiedDiffStart
          const diffLine = hunk.lines[relativeIndex]
          if (diffLine) {
            diffLine.selected = value
          }
        }
      })
    } else {
      const includeAll = selectionType === DiffSelectionType.All ? true : false
      diff.setAllLines(includeAll)
    }

    this.updateChangesState(repository, state => {
      return {
        workingDirectory: state.workingDirectory,
        selectedFile,
        diff,
      }
    })

    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _commitIncludedChanges(repository: Repository, summary: string, description: string): Promise<void> {
    const state = this.getRepositoryState(repository)
    const files = state.changesState.workingDirectory.files.filter(function(file, index, array) {
      return file.selection.getSelectionType() !== DiffSelectionType.None
    })

    await LocalGitOperations.createCommit(repository, summary, description, files)

    return this._loadStatus(repository, true)
  }

  private getIncludeAllState(files: ReadonlyArray<WorkingDirectoryFileChange>): boolean | null {
    const allSelected = files.every(f => f.selection.getSelectionType() === DiffSelectionType.All)
    const noneSelected = files.every(f => f.selection.getSelectionType() === DiffSelectionType.None)

    let includeAll: boolean | null = null
    if (allSelected) {
      includeAll = true
    } else if (noneSelected) {
      includeAll = false
    }

    return includeAll
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _changeFileIncluded(repository: Repository, file: WorkingDirectoryFileChange, include: boolean): Promise<void> {
    this.updateRepositoryState(repository, state => {
      const newFiles = state.changesState.workingDirectory.files.map(f => {
        if (f.id === file.id) {
          return f.withIncludeAll(include)
        } else {
          return f
        }
      })

      const includeAll = this.getIncludeAllState(newFiles)

      let selectedFile: WorkingDirectoryFileChange | undefined
      if (state.changesState.selectedFile) {
          const f = state.changesState.selectedFile
          selectedFile = newFiles.find(file => file.id === f.id)
      }

      const workingDirectory = new WorkingDirectoryStatus(newFiles, includeAll)
      return {
        selectedSection: state.selectedSection,
        changesState: {
          workingDirectory,
          selectedFile: selectedFile || null,
          diff: selectedFile ? state.changesState.diff : null,
        },
        historyState: state.historyState,
        committerEmail: state.committerEmail,
        branchesState: state.branchesState,
        gitHubUsers: state.gitHubUsers,
        commits: state.commits,
      }
    })
    this.emitUpdate()

    return Promise.resolve()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _changeFileLineSelection(repository: Repository, file: WorkingDirectoryFileChange, diffSelection: Map<number, boolean>): Promise<void> {
    this.updateRepositoryState(repository, state => {

      const newFiles = state.changesState.workingDirectory.files.map(f => {
        if (f.id === file.id) {
          return f.withDiffLinesSelection(diffSelection)
        } else {
          return f
        }
      })

      const includeAll = this.getIncludeAllState(newFiles)

      let selectedFile: WorkingDirectoryFileChange | undefined
      if (state.changesState.selectedFile) {
          const f = state.changesState.selectedFile
          selectedFile = newFiles.find(file => file.id === f.id)
      }

      const workingDirectory = new WorkingDirectoryStatus(newFiles, includeAll)
      return {
        selectedSection: state.selectedSection,
        changesState: {
          workingDirectory,
          selectedFile: selectedFile || null,
          diff: selectedFile ? state.changesState.diff : null,
        },
        historyState: state.historyState,
        committerEmail: state.committerEmail,
        branchesState: state.branchesState,
        gitHubUsers: state.gitHubUsers,
        commits: state.commits,
      }
    })
    this.emitUpdate()

    return Promise.resolve()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _changeIncludeAllFiles(repository: Repository, includeAll: boolean): Promise<void> {
    this.updateChangesState(repository, state => {
      return {
        workingDirectory: state.workingDirectory.withIncludeAllFiles(includeAll),
        selectedFile: state.selectedFile,
        diff: state.diff,
      }
    })
    this.emitUpdate()

    return Promise.resolve()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _refreshRepository(repository: Repository): Promise<void> {
    const state = this.getRepositoryState(repository)
    const gitStore = this.getGitStore(repository)

    await gitStore.loadCurrentAndDefaultBranch()

    // When refreshing we *always* load Changes so that we can update the
    // changes indicator in the tab bar. But we only load History if it's
    // selected.
    await this._loadStatus(repository)

    await this.refreshCommitterEmail(repository)

    const section = state.selectedSection
    if (section === RepositorySection.History) {
      return this._loadHistory(repository)
    }
  }

  private async refreshCommitterEmail(repository: Repository): Promise<void> {
    const email = await LocalGitOperations.getConfigValue(repository, 'user.email')
    this.updateRepositoryState(repository, state => {
      return {
        selectedSection: state.selectedSection,
        changesState: state.changesState,
        historyState: state.historyState,
        committerEmail: email,
        branchesState: state.branchesState,
        gitHubUsers: state.gitHubUsers,
        commits: state.commits,
      }
    })
    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _showPopup(popup: Popup): Promise<void> {
    if (popup.type === PopupType.ShowBranches || popup.type === PopupType.CreateBranch) {
      const gitStore = this.getGitStore(popup.repository)
      gitStore.loadBranches()
    }

    this.currentPopup = popup
    this.emitUpdate()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _closePopup(): Promise<void> {
    this.currentPopup = null
    this.emitUpdate()

    return Promise.resolve()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _createBranch(repository: Repository, name: string, startPoint: string): Promise<void> {
    await LocalGitOperations.createBranch(repository, name, startPoint)
    return this._checkoutBranch(repository, name)
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _checkoutBranch(repository: Repository, name: string): Promise<void> {
    await LocalGitOperations.checkoutBranch(repository, name)

    return this._refreshRepository(repository)
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _repositoryWithRefreshedGitHubRepository(repository: Repository): Promise<Repository> {
    let gitHubRepository = repository.gitHubRepository
    if (!gitHubRepository) {
      gitHubRepository = await this.guessGitHubRepository(repository)
    }

    if (!gitHubRepository) { return repository }

    const users = this.users
    const user = getUserForEndpoint(users, gitHubRepository.endpoint)
    if (!user) { return repository }

    const api = new API(user)
    const apiRepo = await api.fetchRepository(gitHubRepository.owner.login, gitHubRepository.name)
    return repository.withGitHubRepository(gitHubRepository.withAPI(apiRepo))
  }

  private async guessGitHubRepository(repository: Repository): Promise<GitHubRepository | null> {
    // TODO: This is all kinds of wrong. We shouldn't assume the remote is named
    // `origin`.
    const remote = await LocalGitOperations.getConfigValue(repository, 'remote.origin.url')
    if (!remote) { return null }

    return matchGitHubRepository(this.users, remote)
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _postError(error: IAppError): Promise<void> {
    const newErrors = Array.from(this.errors)
    newErrors.push(error)
    this.errors = newErrors
    this.emitUpdate()

    return Promise.resolve()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _clearError(error: IAppError): Promise<void> {
    const newErrors = Array.from(this.errors)
    const index = newErrors.findIndex(e => e === error)
    if (index > -1) {
      newErrors.splice(index, 1)
      this.errors = newErrors
      this.emitUpdate()
    }

    return Promise.resolve()
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _validatedRepositoryPath(path: string): Promise<string | null> {
    const gitDir = await LocalGitOperations.getGitDir(path)
    if (!gitDir) { return null }

    return Path.dirname(gitDir)
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _renameBranch(repository: Repository, branch: Branch, newName: string): Promise<void> {
    await LocalGitOperations.renameBranch(repository, branch, newName)

    return this._refreshRepository(repository)
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _deleteBranch(repository: Repository, branch: Branch): Promise<void> {
    const defaultBranch = this.getRepositoryState(repository).branchesState.defaultBranch
    if (!defaultBranch) {
      return Promise.reject(new Error(`No default branch!`))
    }

    await LocalGitOperations.checkoutBranch(repository, defaultBranch.name)
    await LocalGitOperations.deleteBranch(repository, branch)

    return this._refreshRepository(repository)
  }

  public async _push(repository: Repository): Promise<void> {
    const remote = await LocalGitOperations.getDefaultRemote(repository)
    if (!remote) {
      this._showPopup({
        type: PopupType.PublishRepository,
        repository,
      })
      return
    }

    const state = this.getRepositoryState(repository)
    const branch = state.branchesState.currentBranch
    if (!branch) {
      return Promise.reject(new Error('The current branch is unborn.'))
    }

    const user = this.getUserForRepository(repository)
    const upstream = branch.upstream
    if (upstream) {
      return LocalGitOperations.push(repository, user, remote, branch.name, false)
    } else {
      return LocalGitOperations.push(repository, user, remote, branch.name, true)
    }
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _pull(repository: Repository): Promise<void> {
    const remote = await LocalGitOperations.getDefaultRemote(repository)
    if (!remote) {
      return Promise.reject(new Error('The repository has no remotes.'))
    }

    const state = this.getRepositoryState(repository)
    const branch = state.branchesState.currentBranch
    if (!branch) {
      return Promise.reject(new Error('The current branch is unborn.'))
    }

    const user = this.getUserForRepository(repository)
    return LocalGitOperations.pull(repository, user, remote, branch.name)
  }

  private getUserForRepository(repository: Repository): User | null {
    const gitHubRepository = repository.gitHubRepository
    if (!gitHubRepository) { return null }

    return getUserForEndpoint(this.users, gitHubRepository.endpoint)
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public async _publishRepository(repository: Repository, name: string, description: string, private_: boolean, account: User, org: IAPIUser | null): Promise<void> {
    const api = new API(account)
    const apiRepository = await api.createRepository(org, name, description, private_)

    await LocalGitOperations.addRemote(repository.path, 'origin', apiRepository.cloneUrl)

    return this._push(repository)
  }

  /** This shouldn't be called directly. See `Dispatcher`. */
  public _clone(url: string, path: string, user: User | null): { promise: Promise<void>, repository: CloningRepository } {
    const promise = this.cloningRepositoriesStore.clone(url, path, user)
    const repository = this.cloningRepositoriesStore.repositories.find(r => r.url === url && r.path === path)!
    return { promise, repository }
  }

  public _removeCloningRepository(repository: CloningRepository) {
    this.cloningRepositoriesStore.remove(repository)
  }

  public async _discardChanges(repository: Repository, files: ReadonlyArray<WorkingDirectoryFileChange>) {
    const onDiskFiles = files.filter(f => OnDiskStatuses.has(f.status))
    const absolutePaths = onDiskFiles.map(f => Path.join(repository.path, f.path))
    for (const path of absolutePaths) {
      shell.moveItemToTrash(path)
    }

    const modifiedFiles = files.filter(f => CommittedStatuses.has(f.status))
    await LocalGitOperations.checkoutPaths(repository, modifiedFiles.map(f => f.path))

    return this._refreshRepository(repository)
  }
}
