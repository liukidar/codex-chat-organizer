import * as cp from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";

const NO_PROJECT_ID = "__no_project__";

interface HelperResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

interface SchemaResponse extends HelperResponse {
  codex_home: string;
  db_path: string | null;
  session_index_path: string;
  metadata_path: string;
  problems: string[];
  thread_count?: number;
}

interface ProjectRecord {
  id: string;
  name: string;
  created_at: string | null;
  updated_at: string | null;
  builtin: boolean;
}

interface ThreadRecord {
  id: string;
  title: string;
  cwd: string;
  cwd_label: string;
  cwd_color: string;
  rollout_path: string;
  size_bytes: number | null;
  archived: boolean;
  archived_at: number | null;
  updated_at: number;
  updated_at_ms: number | null;
  recency_at: number;
  recency_at_ms: number | null;
  first_user_message: string;
  preview: string;
  git_branch: string;
  git_branch_color: string;
  tags: string[];
  starred: boolean;
  project_id: string;
  project_name: string;
  match?: string;
}

interface ListResponse extends HelperResponse {
  schema: SchemaResponse;
  projects: ProjectRecord[];
  threads: ThreadRecord[];
  query: string;
}

interface TranscriptResponse extends HelperResponse {
  markdown: string;
}

interface WebviewMessage {
  type: string;
  threadId?: string;
  projectId?: string;
  query?: string;
  tag?: string;
  name?: string;
  title?: string;
}

interface BranchProjectPick extends vscode.QuickPickItem {
  branch?: string;
  custom?: boolean;
}

class CodexChatOrganizerView implements vscode.WebviewViewProvider {
  static readonly viewType = "codexChatOrganizer.threads";

  private view: vscode.WebviewView | undefined;
  private projects: ProjectRecord[] = [];
  private threads: ThreadRecord[] = [];
  private searchQuery = "";
  private searchResults: ThreadRecord[] = [];
  private schema: SchemaResponse | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  get activeQuery(): string {
    return this.searchQuery;
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
    });

    this.postLoading("Loading Codex chats...");
    await this.checkCompatibility(false);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    await vscode.commands.executeCommand("setContext", "codexChatOrganizer.hasSearch", Boolean(this.searchQuery));
    this.postLoading("Loading Codex chats...");

    const config = vscode.workspace.getConfiguration("codexChatOrganizer");
    const includeArchived = config.get<boolean>("showArchived", false);
    const searchContent = config.get<boolean>("searchTranscriptContent", true);
    this.log(
      `Refreshing chats: includeArchived=${includeArchived}, searchContent=${searchContent}, searchQuery=${
        this.searchQuery ? "<set>" : "<empty>"
      }`,
    );

    try {
      const response = await runHelper<ListResponse>(
        this.context,
        [
          "list",
          "--limit",
          "500",
          ...(includeArchived ? ["--include-archived"] : []),
        ],
        this.output,
      );
      this.schema = response.schema;
      this.projects = response.projects;
      this.threads = response.ok ? response.threads : [];
      if (response.ok) {
        this.searchResults = this.searchQuery ? await this.loadSearchResults(this.searchQuery, searchContent) : [];
        this.log(
          `Loaded ${this.threads.length} chat(s) across ${this.projects.length} project section(s), ` +
            `${this.searchResults.length} search result(s).`,
        );
        this.postState();
      } else {
        const message = response.schema?.problems?.join("; ") || response.error || "Unknown helper error.";
        this.log(`Helper returned not ok: ${message}`);
        this.postError("Could not load Codex chats.", message);
      }
    } catch (error) {
      this.threads = [];
      const message = errorMessage(error);
      this.log(`Refresh failed:\n${errorDetails(error)}`);
      this.postError("Could not load Codex chats.", message);
    }
  }

  async search(query: string): Promise<void> {
    this.searchQuery = query.trim();
    await vscode.commands.executeCommand("setContext", "codexChatOrganizer.hasSearch", Boolean(this.searchQuery));
    if (!this.searchQuery) {
      this.searchResults = [];
      this.postState();
      return;
    }

    const config = vscode.workspace.getConfiguration("codexChatOrganizer");
    const searchContent = config.get<boolean>("searchTranscriptContent", true);
    try {
      this.searchResults = await this.loadSearchResults(this.searchQuery, searchContent);
      this.postState();
    } catch (error) {
      this.log(`Search failed:\n${errorDetails(error)}`);
      this.postError("Could not search Codex chats.", errorMessage(error));
    }
  }

  private async loadSearchResults(query: string, searchContent: boolean): Promise<ThreadRecord[]> {
    const response = await runHelper<ListResponse>(
      this.context,
      ["list", "--limit", "500", "--query", query, ...(searchContent ? ["--search-content"] : [])],
      this.output,
    );
    return response.ok ? response.threads : [];
  }

  async checkCompatibility(showSuccess: boolean): Promise<boolean> {
    try {
      const schema = await runHelper<SchemaResponse>(this.context, ["schema"], this.output);
      this.schema = schema;
      if (schema.ok) {
        this.log(`Compatibility ok: ${schema.thread_count ?? 0} thread(s), db=${schema.db_path}`);
        if (showSuccess) {
          vscode.window.showInformationMessage(
            `Codex Chat Organizer is compatible. Found ${schema.thread_count ?? 0} threads in ${schema.db_path}.`,
          );
        }
        return true;
      }
      const details = schema.problems.join("; ");
      this.log(`Compatibility failed: ${details}`);
      if (showSuccess) {
        vscode.window.showErrorMessage(`Unsupported Codex state: ${details}`);
      }
      return false;
    } catch (error) {
      this.log(`Compatibility check failed:\n${errorDetails(error)}`);
      if (showSuccess) {
        vscode.window.showErrorMessage(`Could not check Codex compatibility: ${errorMessage(error)}`);
      }
      return false;
    }
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        this.postState();
        return;
      case "refresh":
        await this.refresh();
        return;
      case "search":
        await this.search(message.query || "");
        return;
      case "clearSearch":
        this.searchQuery = "";
        this.searchResults = [];
        await vscode.commands.executeCommand("setContext", "codexChatOrganizer.hasSearch", false);
        this.postState();
        return;
      case "createProject":
        await this.createProject();
        return;
      case "renameProject":
        await this.renameProject(message.projectId, message.name);
        return;
      case "deleteProject":
        await this.deleteProject(message.projectId);
        return;
      case "moveThread":
        await this.moveThread(message.threadId, message.projectId || NO_PROJECT_ID);
        return;
      case "openThread":
        await this.openThread(message.threadId);
        return;
      case "openTranscript":
        await this.openTranscript(message.threadId);
        return;
      case "renameThread":
        await this.renameThread(message.threadId, message.title);
        return;
      case "archiveThread":
        await this.archiveThread(message.threadId);
        return;
      case "toggleStar":
        await this.toggleStar(message.threadId);
        return;
      case "deleteThread":
        await this.deleteThread(message.threadId);
        return;
      case "addTag":
        await this.addTag(message.threadId, message.tag);
        return;
      case "removeTag":
        await this.removeTag(message.threadId, message.tag);
        return;
      case "showDiagnostics":
        this.output.show();
        return;
      default:
        this.log(`Unknown webview message: ${JSON.stringify(message)}`);
    }
  }

  async createProject(): Promise<void> {
    const branchPicks = this.branchProjectPicks();
    let name: string | undefined;
    let branch: string | undefined;
    if (branchPicks.length) {
      const picked = await vscode.window.showQuickPick<BranchProjectPick>(
        [
          ...branchPicks,
          {
            label: "Custom project name...",
            description: "Create an empty project",
            custom: true,
          },
        ],
        {
          title: "Create Project",
          placeHolder: "Pick a branch to move matching chats, or create a custom project.",
        },
      );
      if (!picked) {
        return;
      }
      if (picked.custom) {
        name = await this.promptProjectName();
      } else {
        branch = picked.branch;
        name = branch;
      }
    } else {
      name = await this.promptProjectName();
    }
    if (!name) {
      return;
    }
    const response = await runHelper<HelperResponse>(this.context, ["create-project", "--name", name], this.output);
    const project = response.project;
    if (project && typeof project === "object") {
      const projectRecord = project as ProjectRecord;
      this.projects = this.sortProjects([...this.projects, projectRecord]);
      const threadIds = branch ? this.threadIdsForBranch(branch) : [];
      if (threadIds.length) {
        await runHelper<HelperResponse>(
          this.context,
          ["move-threads", "--thread-ids", threadIds.join(","), "--project-id", projectRecord.id],
          this.output,
        );
        this.threads = this.updateThreadsProject(this.threads, threadIds, projectRecord);
        this.searchResults = this.updateThreadsProject(this.searchResults, threadIds, projectRecord);
      }
      this.postState();
    } else {
      await this.refresh();
    }
  }

  private async renameProject(projectId: string | undefined, requestedName?: string): Promise<void> {
    const project = this.projectById(projectId);
    if (!project || project.builtin) {
      return;
    }
    let name = requestedName?.trim();
    if (name === undefined) {
      const picked = await vscode.window.showInputBox({
        title: "Rename Project",
        value: project.name,
        validateInput: (value) => (value.trim() ? undefined : "Project name cannot be empty."),
      });
      if (picked === undefined) {
        return;
      }
      name = picked.trim();
    }
    if (!name || name === project.name) {
      return;
    }
    await runHelper<HelperResponse>(
      this.context,
      ["rename-project", "--project-id", project.id, "--name", name],
      this.output,
    );
    this.projects = this.projects.map((candidate) => (candidate.id === project.id ? { ...candidate, name } : candidate));
    this.threads = this.threads.map((thread) =>
      thread.project_id === project.id ? { ...thread, project_name: name } : thread,
    );
    this.searchResults = this.searchResults.map((thread) =>
      thread.project_id === project.id ? { ...thread, project_name: name } : thread,
    );
    this.postState();
  }

  private async deleteProject(projectId: string | undefined): Promise<void> {
    const project = this.projectById(projectId);
    if (!project || project.builtin) {
      return;
    }
    await runHelper<HelperResponse>(this.context, ["delete-project", "--project-id", project.id], this.output);
    this.projects = this.projects.filter((candidate) => candidate.id !== project.id);
    this.threads = this.moveThreadsToNoProject(this.threads, project.id);
    this.searchResults = this.moveThreadsToNoProject(this.searchResults, project.id);
    this.postState();
  }

  private async moveThread(threadId: string | undefined, projectId: string): Promise<void> {
    const thread = this.threadById(threadId);
    const project = this.projectById(projectId);
    if (!thread || !project || thread.project_id === project.id) {
      return;
    }
    await runHelper<HelperResponse>(
      this.context,
      ["move-thread", "--thread-id", thread.id, "--project-id", project.id],
      this.output,
    );
    this.threads = this.updateThreadProject(this.threads, thread.id, project);
    this.searchResults = this.updateThreadProject(this.searchResults, thread.id, project);
    this.postState();
  }

  private async openThread(threadId: string | undefined): Promise<void> {
    const thread = this.threadById(threadId);
    if (!thread) {
      return;
    }

    const codexExtension = vscode.extensions.getExtension("openai.chatgpt");
    if (codexExtension) {
      const route = vscode.Uri.parse(`${vscode.env.uriScheme}://openai.chatgpt/local/${encodeURIComponent(thread.id)}`);
      try {
        const opened = await vscode.env.openExternal(route);
        if (opened) {
          this.log(`Opened Codex deep link for thread ${thread.id}.`);
          return;
        }
        this.log(`Codex deep link was not accepted for thread ${thread.id}; opening transcript fallback.`);
      } catch (error) {
        this.log(`Codex deep link failed for thread ${thread.id}: ${errorMessage(error)}`);
      }
    } else {
      this.log("OpenAI Codex extension is not installed; opening transcript fallback.");
    }

    await this.openTranscript(thread.id);
  }

  private async openTranscript(threadId: string | undefined): Promise<void> {
    const thread = this.threadById(threadId);
    if (!thread) {
      return;
    }
    const response = await runHelper<TranscriptResponse>(this.context, ["transcript", "--thread-id", thread.id], this.output);
    const document = await vscode.workspace.openTextDocument({
      content: response.markdown,
      language: "markdown",
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async renameThread(threadId: string | undefined, requestedTitle?: string): Promise<void> {
    const thread = this.threadById(threadId);
    if (!thread) {
      return;
    }
    let title = requestedTitle?.trim();
    if (title === undefined) {
      const picked = await vscode.window.showInputBox({
        title: "Rename Codex Chat",
        prompt: "This updates Codex local state and should appear in the Codex extension.",
        value: thread.title,
        validateInput: (value) => (value.trim() ? undefined : "Title cannot be empty."),
      });
      if (picked === undefined) {
        return;
      }
      title = picked.trim();
    }
    if (!title || title === thread.title) {
      return;
    }
    await mutateCodexState(this.context, ["rename", "--thread-id", thread.id, "--title", title], this.output);
    this.threads = this.updateThreadTitle(this.threads, thread.id, title);
    this.searchResults = this.updateThreadTitle(this.searchResults, thread.id, title);
    this.postState();
  }

  private async archiveThread(threadId: string | undefined): Promise<void> {
    const thread = this.threadById(threadId);
    if (!thread) {
      return;
    }
    const archived = !thread.archived;
    await mutateCodexState(this.context, ["archive", "--thread-id", thread.id, "--archived", String(archived)], this.output);
    if (vscode.workspace.getConfiguration("codexChatOrganizer").get<boolean>("showArchived", false)) {
      this.threads = this.updateThreadArchived(this.threads, thread.id, archived);
    } else {
      this.threads = this.threads.filter((candidate) => candidate.id !== thread.id);
    }
    this.searchResults = this.searchResults.filter((candidate) => candidate.id !== thread.id);
    this.postState();
  }

  private async toggleStar(threadId: string | undefined): Promise<void> {
    const thread = this.threadById(threadId);
    if (!thread) {
      return;
    }
    const starred = !thread.starred;
    await runHelper<HelperResponse>(
      this.context,
      ["set-star", "--thread-id", thread.id, "--starred", String(starred)],
      this.output,
    );
    this.threads = this.updateThreadStarred(this.threads, thread.id, starred);
    this.searchResults = this.updateThreadStarred(this.searchResults, thread.id, starred);
    this.postState();
  }

  private async deleteThread(threadId: string | undefined): Promise<void> {
    const thread = this.threadById(threadId);
    if (!thread) {
      return;
    }
    await mutateCodexState(this.context, ["delete-thread", "--thread-id", thread.id], this.output);
    this.threads = this.threads.filter((candidate) => candidate.id !== thread.id);
    this.searchResults = this.searchResults.filter((candidate) => candidate.id !== thread.id);
    this.postState();
  }

  private async addTag(threadId: string | undefined, requestedTag?: string): Promise<void> {
    const thread = this.threadById(threadId);
    if (!thread) {
      return;
    }
    let tag = requestedTag?.trim();
    if (tag === undefined) {
      const picked = await vscode.window.showInputBox({
        title: "Add Organizer Tag",
        validateInput: (value) => (value.trim() ? undefined : "Tag cannot be empty."),
      });
      if (picked === undefined) {
        return;
      }
      tag = picked.trim();
    }
    if (!tag) {
      return;
    }
    const nextTags = [...new Set([...thread.tags, tag])].sort();
    await this.saveTags(thread, nextTags);
    this.threads = this.updateThreadTags(this.threads, thread.id, nextTags);
    this.searchResults = this.updateThreadTags(this.searchResults, thread.id, nextTags);
    this.postState();
  }

  private async removeTag(threadId: string | undefined, tag: string | undefined): Promise<void> {
    const thread = this.threadById(threadId);
    if (!thread || !tag) {
      return;
    }
    const nextTags = thread.tags.filter((candidate) => candidate !== tag);
    await this.saveTags(thread, nextTags);
    this.threads = this.updateThreadTags(this.threads, thread.id, nextTags);
    this.searchResults = this.updateThreadTags(this.searchResults, thread.id, nextTags);
    this.postState();
  }

  private async saveTags(thread: ThreadRecord, tags: string[]): Promise<void> {
    await runHelper<HelperResponse>(
      this.context,
      ["set-tags", "--thread-id", thread.id, "--tags", tags.join(", ")],
      this.output,
    );
  }

  private async promptProjectName(): Promise<string | undefined> {
    const name = await vscode.window.showInputBox({
      title: "Create Project",
      prompt: "Chats can be dragged into this project after it is created.",
      validateInput: (value) => (value.trim() ? undefined : "Project name cannot be empty."),
    });
    return name?.trim() || undefined;
  }

  private branchProjectPicks(): BranchProjectPick[] {
    const workspacePath = this.currentWorkspacePath();
    const branchCounts = new Map<string, number>();
    for (const thread of this.threads) {
      if (!thread.git_branch || !this.threadBelongsToWorkspace(thread, workspacePath)) {
        continue;
      }
      branchCounts.set(thread.git_branch, (branchCounts.get(thread.git_branch) || 0) + 1);
    }
    return [...branchCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([branch, count]) => ({
        label: branch,
        description: `${count} chat${count === 1 ? "" : "s"}`,
        branch,
      }));
  }

  private threadIdsForBranch(branch: string): string[] {
    const workspacePath = this.currentWorkspacePath();
    return this.threads
      .filter((thread) => thread.git_branch === branch && this.threadBelongsToWorkspace(thread, workspacePath))
      .map((thread) => thread.id);
  }

  private currentWorkspacePath(): string | undefined {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      const folder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
      if (folder) {
        return folder.uri.fsPath;
      }
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private threadBelongsToWorkspace(thread: ThreadRecord, workspacePath: string | undefined): boolean {
    if (!workspacePath) {
      return true;
    }
    const workspaceRoot = path.resolve(workspacePath);
    const threadCwd = path.resolve(thread.cwd);
    return threadCwd === workspaceRoot || threadCwd.startsWith(`${workspaceRoot}${path.sep}`);
  }

  private sortProjects(projects: ProjectRecord[]): ProjectRecord[] {
    return projects.sort((left, right) => {
      if (left.builtin) {
        return -1;
      }
      if (right.builtin) {
        return 1;
      }
      return left.name.localeCompare(right.name);
    });
  }

  private projectById(projectId: string | undefined): ProjectRecord | undefined {
    return this.projects.find((project) => project.id === projectId);
  }

  private threadById(threadId: string | undefined): ThreadRecord | undefined {
    return this.threads.find((thread) => thread.id === threadId);
  }

  private noProject(): ProjectRecord {
    return this.projects.find((project) => project.id === NO_PROJECT_ID) || {
      id: NO_PROJECT_ID,
      name: "No Project",
      created_at: null,
      updated_at: null,
      builtin: true,
    };
  }

  private updateThreadProject(threads: ThreadRecord[], threadId: string, project: ProjectRecord): ThreadRecord[] {
    return threads.map((thread) =>
      thread.id === threadId ? { ...thread, project_id: project.id, project_name: project.name } : thread,
    );
  }

  private updateThreadsProject(threads: ThreadRecord[], threadIds: string[], project: ProjectRecord): ThreadRecord[] {
    const ids = new Set(threadIds);
    return threads.map((thread) =>
      ids.has(thread.id) ? { ...thread, project_id: project.id, project_name: project.name } : thread,
    );
  }

  private moveThreadsToNoProject(threads: ThreadRecord[], projectId: string): ThreadRecord[] {
    const noProject = this.noProject();
    return threads.map((thread) =>
      thread.project_id === projectId ? { ...thread, project_id: noProject.id, project_name: noProject.name } : thread,
    );
  }

  private updateThreadTitle(threads: ThreadRecord[], threadId: string, title: string): ThreadRecord[] {
    return threads.map((thread) => (thread.id === threadId ? { ...thread, title } : thread));
  }

  private updateThreadArchived(threads: ThreadRecord[], threadId: string, archived: boolean): ThreadRecord[] {
    return threads.map((thread) => (thread.id === threadId ? { ...thread, archived } : thread));
  }

  private updateThreadStarred(threads: ThreadRecord[], threadId: string, starred: boolean): ThreadRecord[] {
    return threads.map((thread) => (thread.id === threadId ? { ...thread, starred } : thread));
  }

  private updateThreadTags(threads: ThreadRecord[], threadId: string, tags: string[]): ThreadRecord[] {
    return threads.map((thread) => (thread.id === threadId ? { ...thread, tags } : thread));
  }

  private postLoading(message: string): void {
    this.post({ type: "loading", message, searchQuery: this.searchQuery });
  }

  private postError(title: string, message: string): void {
    this.post({ type: "error", title, message, searchQuery: this.searchQuery });
  }

  private postState(): void {
    this.post({
      type: "state",
      projects: this.projects,
      threads: this.threads,
      searchQuery: this.searchQuery,
      searchResults: this.searchResults,
      schema: this.schema,
    });
  }

  private post(message: Record<string, unknown>): void {
    void this.view?.webview.postMessage(message);
  }

  private log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  private html(_webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --border: var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      --card-bg: var(--vscode-sideBar-background);
      --card-hover: var(--vscode-list-hoverBackground);
      --muted: var(--vscode-descriptionForeground);
      --button-bg: var(--vscode-button-secondaryBackground);
      --button-fg: var(--vscode-button-secondaryForeground);
      --button-hover: var(--vscode-button-secondaryHoverBackground);
      --selected-bg: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
      --selected-fg: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
    }

    * {
      box-sizing: border-box;
    }

    html,
    body {
      height: 100%;
      overflow: hidden;
    }

    body {
      margin: 0;
      padding: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font: var(--vscode-font-size) var(--vscode-font-family);
    }

    body.dragging,
    body.dragging * {
      cursor: grabbing !important;
    }

    button,
    input {
      font: inherit;
    }

    button {
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--button-fg);
      background: var(--button-bg);
      min-height: 26px;
      padding: 2px 8px;
      cursor: pointer;
    }

    button:hover {
      background: var(--button-hover);
    }

    input {
      min-width: 0;
      min-height: 28px;
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 4px;
      padding: 3px 7px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
    }

    .shell {
      display: flex;
      height: 100vh;
      min-height: 0;
      flex-direction: column;
      overflow: hidden;
    }

    .toolbar {
      display: grid;
      flex: 0 0 auto;
      grid-template-columns: 1fr auto auto;
      gap: 6px;
      padding: 8px;
      border-bottom: 1px solid var(--border);
      background: var(--vscode-sideBar-background);
      position: sticky;
      top: 0;
      z-index: 2;
    }

    .icon-button {
      display: inline-grid;
      place-items: center;
      width: 34px;
      min-width: 34px;
      min-height: 32px;
      padding: 0;
      border: 0;
      border-radius: 7px;
      background: transparent;
      line-height: 1;
    }

    .icon-button:hover,
    .title-toggle:hover,
    .project-action:hover,
    .card-action:hover,
    .tag-add:hover,
    .tag-remove:hover {
      background: var(--button-hover);
    }

    .icon {
      display: block;
      width: 18px;
      height: 18px;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
      fill: none;
    }

    .tag-add .icon,
    .tag-remove .icon {
      width: 12px;
      height: 12px;
    }

    .project-action .icon,
    .title-toggle .icon {
      width: 15px;
      height: 15px;
    }

    .card-action .icon {
      width: 17px;
      height: 17px;
    }

    .status {
      display: none;
      padding: 10px 12px;
      color: var(--muted);
    }

    .status.visible {
      display: block;
    }

    .project-panel {
      flex: 0 0 auto;
      border-bottom: 1px solid var(--border);
      padding: 8px;
    }

    .project-panel-header {
      display: grid;
      grid-template-columns: auto minmax(90px, 1fr) auto;
      gap: 8px;
      align-items: center;
      margin-bottom: 7px;
    }

    .project-panel-title {
      color: var(--muted);
      font-size: 11px;
      font-weight: 650;
      letter-spacing: 0;
      text-transform: uppercase;
    }

    .project-panel-actions {
      display: flex;
      gap: 5px;
    }

    .project-search {
      justify-self: end;
      width: min(220px, 42vw);
      min-height: 26px;
      padding: 2px 7px;
    }

    .project-filters {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }

    .project-chip {
      display: inline-flex;
      align-items: center;
      max-width: 100%;
      gap: 7px;
      border: 1px solid var(--border);
      border-radius: 8px;
      min-height: 42px;
      padding: 7px 9px;
      color: var(--vscode-foreground);
      background: transparent;
      cursor: pointer;
      user-select: none;
    }

    .project-chip[data-active="true"] {
      border-color: var(--vscode-focusBorder);
      color: var(--selected-fg);
      background: var(--selected-bg);
    }

    .project-chip:hover {
      background: var(--card-hover);
    }

    .project-chip[data-active="true"]:hover {
      background: var(--selected-bg);
    }

    .project-chip:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }

    .project-chip.drag-over,
    .project-clear.drag-over {
      border-color: var(--vscode-focusBorder);
      box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
      background: var(--selected-bg);
    }

    .project-chip-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .project-chip-count {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-height: 22px;
      padding: 2px 6px;
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      font-variant-numeric: tabular-nums;
    }

    .project-chip-count-value {
      font-size: 10px;
      line-height: 1;
    }

    .project-chip-count .icon {
      width: 13px;
      height: 13px;
    }

    .project-clear {
      display: inline-grid;
      place-items: center;
      width: 32px;
      min-width: 32px;
      min-height: 32px;
      margin-left: auto;
      justify-content: center;
      padding: 0;
      border: 0;
      border-radius: 7px;
      color: var(--button-fg);
      background: transparent;
    }

    .project-actions-inline {
      display: inline-flex;
      flex: 0 0 70px;
      justify-content: flex-end;
      gap: 2px;
      margin-left: 2px;
    }

    .project-action {
      display: inline-grid;
      place-items: center;
      width: 22px;
      min-width: 22px;
      min-height: 22px;
      padding: 0;
      border: 0;
      border-radius: 6px;
      background: transparent;
    }

    .project-name-input {
      min-height: 24px;
      width: min(170px, 42vw);
      padding: 1px 5px;
    }

    .chat-list {
      display: grid;
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      align-content: start;
      gap: 7px;
      padding: 8px;
    }

    .section-heading {
      color: var(--muted);
      font-size: 11px;
      font-weight: 650;
      letter-spacing: 0;
      text-transform: uppercase;
      padding: 7px 1px 1px;
    }

    .project-result-heading {
      color: var(--muted);
      font-size: 11px;
      font-weight: 600;
      padding: 3px 1px 0;
    }

    .empty-list {
      border: 1px dashed var(--border);
      border-radius: 6px;
      padding: 10px;
      color: var(--muted);
      font-size: 12px;
    }

    .card {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px;
      background: var(--card-bg);
      cursor: grab;
      transition:
        background 120ms ease,
        border-color 120ms ease,
        opacity 120ms ease,
        transform 120ms ease;
    }

    .card:hover {
      background: var(--card-hover);
    }

    .card.opened {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-list-inactiveSelectionBackground, var(--card-hover));
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 45%, transparent);
    }

    .card:active {
      cursor: grabbing;
    }

    .card.dragging {
      opacity: 0.46;
      border-color: var(--vscode-focusBorder);
      transform: scale(0.995);
    }

    .drag-ghost {
      position: fixed;
      top: -1000px;
      left: -1000px;
      pointer-events: none;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      max-width: 360px;
      border: 1px solid var(--vscode-focusBorder);
      border-radius: 8px;
      padding: 8px 10px;
      color: var(--vscode-foreground);
      background: var(--vscode-editorWidget-background, var(--card-bg));
      box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
      font-weight: 600;
    }

    .drag-ghost-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .card-top-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      margin-bottom: 5px;
    }

    .card-title-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 6px;
      align-items: start;
      margin-bottom: 6px;
    }

    .card-title {
      margin: 0;
      max-height: 2.5em;
      font-size: 0.95em;
      line-height: 1.25;
      font-weight: 560;
      overflow-wrap: anywhere;
      overflow: hidden;
      transition: max-height 170ms ease;
    }

    .card-title.expanded {
      max-height: 40rem;
      overflow: visible;
    }

    .title-toggle {
      display: inline-grid;
      place-items: center;
      width: 24px;
      min-width: 24px;
      min-height: 24px;
      padding: 0;
      border: 0;
      border-radius: 7px;
      background: transparent;
      line-height: 1;
    }

    .title-edit {
      width: 100%;
      min-height: 28px;
      font-weight: 560;
    }

    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      color: var(--muted);
      font-size: 11px;
    }

    .tag-row {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-bottom: 0;
    }

    .tag-pill {
      display: inline-flex;
      align-items: center;
      min-width: 0;
      max-width: 100%;
      gap: 5px;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px 6px;
      color: var(--vscode-foreground);
      font-size: 11px;
    }

    .tag-pill.fixed {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .swatch {
      width: 8px;
      height: 8px;
      flex: 0 0 auto;
      border-radius: 2px;
      background: var(--tag-color);
    }

    .tag-text {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tag-remove,
    .tag-add {
      display: inline-grid;
      place-items: center;
      width: 20px;
      min-width: 20px;
      min-height: 20px;
      padding: 0;
      border: 0;
      border-radius: 6px;
      background: transparent;
      line-height: 1;
    }

    .tag-input {
      width: min(140px, 45vw);
      min-height: 22px;
      padding: 1px 5px;
      font-size: 11px;
    }

    .match,
    .tags {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.3;
      margin: 7px 0;
      overflow-wrap: anywhere;
    }

    .card-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      justify-content: flex-end;
      min-height: 26px;
    }

    .card-action {
      display: inline-grid;
      place-items: center;
      width: 28px;
      min-width: 28px;
      min-height: 26px;
      padding: 0;
      border: 0;
      border-radius: 7px;
      background: transparent;
    }

    .card-action.starred {
      color: var(--vscode-charts-yellow, #d7ba7d);
    }

    .confirm-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 26px;
      min-height: 26px;
      padding: 0 9px;
      border: 0;
      border-radius: 999px;
      color: var(--vscode-errorForeground);
      background: color-mix(in srgb, var(--vscode-errorForeground) 18%, transparent);
      font-size: 11px;
      font-weight: 650;
      line-height: 1;
    }

    .confirm-action:hover {
      background: color-mix(in srgb, var(--vscode-errorForeground) 26%, transparent);
    }

    .project-confirm {
      width: 68px;
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="project-panel">
      <div class="project-panel-header">
        <div class="project-panel-title">Projects</div>
        <input id="project-query" class="project-search" type="search" placeholder="Filter projects">
        <div class="project-panel-actions">
          <button id="create-project" class="icon-button" type="button" title="New project" aria-label="New project"></button>
          <button id="refresh" class="icon-button" type="button" title="Refresh" aria-label="Refresh"></button>
        </div>
      </div>
      <div id="project-filters" class="project-filters"></div>
    </section>
    <div class="toolbar">
      <input id="query" type="search" placeholder="Search chats">
      <button id="search" class="icon-button" type="button" title="Search" aria-label="Search"></button>
      <button id="clear" class="icon-button" type="button" title="Clear search" aria-label="Clear search"></button>
    </div>
    <div id="status" class="status visible">Loading Codex chats...</div>
    <div id="chat-list" class="chat-list"></div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const noProjectId = "${NO_PROJECT_ID}";
    const collapsedTitleLength = 180;
    let state = { projects: [], threads: [], searchQuery: "", searchResults: [], loading: true };
    let draggedThreadId = null;
    let selectedProjectId = noProjectId;
    let editingProjectId = null;
    let editingThreadId = null;
    let addingTagThreadId = null;
    let pendingConfirm = null;
    let titleFilter = "";
    let projectFilter = "";
    let activeDrag = null;
    let openedThreadId = null;
    const expandedTitles = new Set();

    const queryInput = document.getElementById("query");
    const projectQueryInput = document.getElementById("project-query");
    const projectFiltersRoot = document.getElementById("project-filters");
    const chatListRoot = document.getElementById("chat-list");
    const statusRoot = document.getElementById("status");

    installIcon("search", "search");
    installIcon("clear", "x");
    installIcon("create-project", "plus");
    installIcon("refresh", "refresh");

    document.getElementById("search").addEventListener("click", () => {
      vscode.postMessage({ type: "search", query: queryInput.value });
    });

    document.getElementById("clear").addEventListener("click", () => {
      queryInput.value = "";
      titleFilter = "";
      vscode.postMessage({ type: "clearSearch" });
    });

    document.getElementById("refresh").addEventListener("click", () => {
      vscode.postMessage({ type: "refresh" });
    });

    document.getElementById("create-project").addEventListener("click", () => {
      vscode.postMessage({ type: "createProject" });
    });

    queryInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        vscode.postMessage({ type: "search", query: queryInput.value });
      }
    });

    queryInput.addEventListener("input", () => {
      titleFilter = queryInput.value;
      render();
    });

    projectQueryInput.addEventListener("input", () => {
      projectFilter = projectQueryInput.value;
      render();
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "loading") {
        state = {
          projects: [],
          threads: [],
          searchQuery: message.searchQuery || "",
          searchResults: [],
          loading: true,
          status: message.message,
        };
        render();
        return;
      }
      if (message.type === "error") {
        state = {
          projects: [],
          threads: [],
          searchQuery: message.searchQuery || "",
          searchResults: [],
          loading: false,
          error: message.title + " " + message.message,
        };
        render();
        return;
      }
      if (message.type === "state") {
        state = {
          projects: message.projects || [],
          threads: message.threads || [],
          searchQuery: message.searchQuery || "",
          searchResults: message.searchResults || [],
          loading: false,
        };
        pruneSelections();
        render();
      }
    });

    vscode.postMessage({ type: "ready" });

    function render() {
      projectFiltersRoot.textContent = "";
      chatListRoot.textContent = "";

      if (state.loading || state.error) {
        statusRoot.classList.add("visible");
        statusRoot.textContent = state.error || state.status || "Loading Codex chats...";
        return;
      }

      statusRoot.classList.remove("visible");
      statusRoot.textContent = "";

      const counts = countByProject();
      const projectQuery = projectFilter.trim().toLowerCase();
      for (const project of state.projects.filter((candidate) => {
        if (candidate.id === noProjectId) {
          return false;
        }
        if (!projectQuery) {
          return true;
        }
        return candidate.name.toLowerCase().includes(projectQuery);
      })) {
        projectFiltersRoot.appendChild(renderProjectChip(project, counts.get(project.id) || 0));
      }
      projectFiltersRoot.appendChild(renderClearProjectChip());

      const visibleThreads = filteredThreads();
      if (!visibleThreads.length) {
        const empty = document.createElement("div");
        empty.className = "empty-list";
        empty.textContent = "No chats match this filter.";
        chatListRoot.appendChild(empty);
      } else {
        for (const thread of visibleThreads) {
          chatListRoot.appendChild(renderCard(thread));
        }
      }

      renderSearchResults();
    }

    function renderProjectChip(project, count) {
      const isActive = selectedProjectId === project.id;
      const chip = document.createElement("div");
      chip.className = "project-chip";
      chip.dataset.active = String(isActive);
      chip.dataset.projectId = project.id;
      chip.tabIndex = 0;
      chip.setAttribute("role", "button");
      chip.title = draggedThreadId ? "Move chat to " + project.name : "Show " + project.name;
      chip.addEventListener("click", (event) => {
        if (event.target.closest("button, input")) {
          return;
        }
        selectProject(project.id);
      });
      chip.addEventListener("keydown", (event) => {
        if (event.target.closest("input")) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectProject(project.id);
        }
      });

      const badge = document.createElement("span");
      badge.className = "project-chip-count";
      badge.appendChild(icon("folder"));
      const countText = document.createElement("span");
      countText.className = "project-chip-count-value";
      countText.textContent = String(count);
      badge.appendChild(countText);
      chip.appendChild(badge);
      if (editingProjectId === project.id) {
        const input = document.createElement("input");
        input.className = "project-name-input";
        input.value = project.name;
        input.setAttribute("aria-label", "Project name");
        input.addEventListener("click", (event) => event.stopPropagation());
        let finished = false;
        const finish = (save) => {
          if (finished) {
            return;
          }
          finished = true;
          const value = input.value.trim();
          editingProjectId = null;
          if (save && value && value !== project.name) {
            vscode.postMessage({ type: "renameProject", projectId: project.id, name: value });
          } else {
            render();
          }
        };
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            finish(true);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            finish(false);
          }
        });
        input.addEventListener("blur", () => finish(true));
        chip.appendChild(input);
      } else {
        const name = document.createElement("span");
        name.className = "project-chip-name";
        name.textContent = project.name;
        chip.appendChild(name);
      }

      if (!project.builtin) {
        const actions = document.createElement("span");
        actions.className = "project-actions-inline";
        if (pendingConfirm === "project-delete:" + project.id) {
          actions.appendChild(confirmButton(() => {
            pendingConfirm = null;
            vscode.postMessage({ type: "deleteProject", projectId: project.id });
          }, "confirm-action project-confirm"));
        } else {
          actions.append(
            iconButton("edit", "Rename project", () => {
              editingProjectId = project.id;
              pendingConfirm = null;
              render();
              focusSelector(".project-name-input");
            }, "project-action"),
            iconButton("trash", "Delete project", () => {
              pendingConfirm = "project-delete:" + project.id;
              render();
            }, "project-action"),
          );
        }
        chip.appendChild(actions);
      }

      return chip;
    }

    function renderClearProjectChip() {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "project-clear";
      chip.dataset.projectId = noProjectId;
      setClearProjectChipState(chip);
      chip.addEventListener("click", () => selectProject(noProjectId));
      return chip;
    }

    function setClearProjectChipState(chip) {
      const isMoveOutTarget = Boolean(draggedThreadId && selectedProjectId !== noProjectId);
      chip.textContent = "";
      chip.title = isMoveOutTarget ? "Move chat out of project" : "Clear project filter";
      chip.setAttribute("aria-label", chip.title);
      chip.appendChild(icon(isMoveOutTarget ? "folder-minus" : "x"));
    }

    function updateClearProjectDropState() {
      const chip = document.querySelector(".project-clear");
      if (chip) {
        setClearProjectChipState(chip);
      }
    }

    function renderCard(thread) {
      const card = document.createElement("article");
      card.className = "card";
      if (thread.id === openedThreadId) {
        card.classList.add("opened");
      }
      card.dataset.threadId = thread.id;
      installCardPointerHandlers(card, thread);

      const titleText = thread.title || "(untitled)";
      const topRow = document.createElement("div");
      topRow.className = "card-top-row";

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.append(metaItem("Edited " + formatDate(thread.updated_at_ms || thread.updated_at * 1000)));
      meta.append(metaItem(formatSize(thread.size_bytes)));
      if (thread.archived) {
        meta.append(metaItem("Archived"));
      }
      topRow.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "card-actions";
      if (pendingConfirm === "archive:" + thread.id) {
        actions.appendChild(confirmButton(() => {
          pendingConfirm = null;
          vscode.postMessage({ type: "archiveThread", threadId: thread.id });
        }));
      } else if (pendingConfirm === "delete-thread:" + thread.id) {
        actions.appendChild(confirmButton(() => {
          pendingConfirm = null;
          vscode.postMessage({ type: "deleteThread", threadId: thread.id });
        }));
      } else {
        actions.append(
          iconButton(thread.starred ? "star-filled" : "star", thread.starred ? "Unstar chat" : "Star chat", () => {
            vscode.postMessage({ type: "toggleStar", threadId: thread.id });
          }, thread.starred ? "card-action starred" : "card-action"),
          iconButton("edit", "Rename chat", () => {
            editingThreadId = thread.id;
            pendingConfirm = null;
            render();
            focusSelector(".title-edit");
          }, "card-action"),
          iconButton(thread.archived ? "unarchive" : "archive", thread.archived ? "Unarchive chat" : "Archive chat", () => {
            if (thread.archived) {
              vscode.postMessage({ type: "archiveThread", threadId: thread.id });
              return;
            }
            pendingConfirm = "archive:" + thread.id;
            render();
          }, "card-action"),
          iconButton("trash", "Delete chat", () => {
            pendingConfirm = "delete-thread:" + thread.id;
            render();
          }, "card-action"),
        );
      }
      topRow.appendChild(actions);
      card.appendChild(topRow);

      const titleRow = document.createElement("div");
      titleRow.className = "card-title-row";
      if (editingThreadId === thread.id) {
        const input = document.createElement("input");
        input.className = "title-edit";
        input.value = titleText;
        input.setAttribute("aria-label", "Chat title");
        input.addEventListener("click", (event) => event.stopPropagation());
        let finished = false;
        const finish = (save) => {
          if (finished) {
            return;
          }
          finished = true;
          const value = input.value.trim();
          editingThreadId = null;
          if (save && value && value !== titleText) {
            vscode.postMessage({ type: "renameThread", threadId: thread.id, title: value });
          }
          render();
        };
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            finish(true);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            finish(false);
          }
        });
        input.addEventListener("blur", () => finish(true));
        titleRow.appendChild(input);
      } else {
        const title = document.createElement("h3");
        title.className = "card-title";
        if (expandedTitles.has(thread.id)) {
          title.classList.add("expanded");
        }
        title.textContent = titleText;
        titleRow.appendChild(title);
      }
      if (titleText.length > collapsedTitleLength && editingThreadId !== thread.id) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "title-toggle";
        toggle.title = expandedTitles.has(thread.id) ? "Collapse title" : "Expand title";
        toggle.appendChild(icon(expandedTitles.has(thread.id) ? "chevron-up" : "chevron-down"));
        toggle.addEventListener("click", (event) => {
          event.stopPropagation();
          if (expandedTitles.has(thread.id)) {
            expandedTitles.delete(thread.id);
          } else {
            expandedTitles.add(thread.id);
          }
          render();
        });
        titleRow.appendChild(toggle);
      }
      card.appendChild(titleRow);

      card.appendChild(renderTags(thread));

      if (thread.match) {
        const match = document.createElement("div");
        match.className = "match";
        match.textContent = thread.match;
        card.appendChild(match);
      }

      return card;
    }

    function installCardPointerHandlers(card, thread) {
      card.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.target.closest("button, input")) {
          return;
        }
        if (editingThreadId === thread.id || addingTagThreadId === thread.id) {
          return;
        }

        event.preventDefault();
        const startX = event.clientX;
        const startY = event.clientY;
        let didDrag = false;
        let currentTarget = null;
        let ghost = null;

        const beginDrag = (moveEvent) => {
          didDrag = true;
          draggedThreadId = thread.id;
          card.classList.add("dragging");
          document.body.classList.add("dragging");
          updateClearProjectDropState();
          ghost = dragGhost(thread);
          document.body.appendChild(ghost);
          moveGhost(ghost, moveEvent);
        };

        const finish = (upEvent) => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", finish);
          window.removeEventListener("pointercancel", cancel);
          try {
            card.releasePointerCapture(event.pointerId);
          } catch {
            // Ignore stale pointer capture.
          }

          if (didDrag) {
            const target = projectDropTarget(upEvent) || currentTarget;
            cleanupPointerDrag(card, ghost);
            if (target) {
              selectedProjectId = target.id;
              vscode.postMessage({ type: "moveThread", threadId: thread.id, projectId: target.id });
            }
            return;
          }

          if (pendingConfirm) {
            pendingConfirm = null;
            render();
            return;
          }
          openedThreadId = thread.id;
          render();
          vscode.postMessage({ type: "openThread", threadId: thread.id });
        };

        const cancel = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", finish);
          window.removeEventListener("pointercancel", cancel);
          cleanupPointerDrag(card, ghost);
        };

        const move = (moveEvent) => {
          const dx = moveEvent.clientX - startX;
          const dy = moveEvent.clientY - startY;
          if (!didDrag && Math.hypot(dx, dy) < 6) {
            return;
          }
          if (!didDrag) {
            beginDrag(moveEvent);
          }
          if (ghost) {
            moveGhost(ghost, moveEvent);
          }
          clearDragTargets();
          currentTarget = projectDropTarget(moveEvent);
          if (currentTarget) {
            const chip = document.querySelector(
              '.project-chip[data-project-id="' +
                cssEscape(currentTarget.id) +
                '"], .project-clear[data-project-id="' +
                cssEscape(currentTarget.id) +
                '"]',
            );
            chip?.classList.add("drag-over");
          }
        };

        try {
          card.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture is best effort in the VS Code webview.
        }
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", finish);
        window.addEventListener("pointercancel", cancel);
      });
    }

    function cleanupPointerDrag(card, ghost) {
      draggedThreadId = null;
      card.classList.remove("dragging");
      document.body.classList.remove("dragging");
      ghost?.remove();
      clearDragTargets();
      updateClearProjectDropState();
    }

    function moveGhost(ghost, event) {
      ghost.style.left = event.clientX + 12 + "px";
      ghost.style.top = event.clientY + 12 + "px";
    }

    function projectDropTarget(event) {
      const element = document.elementFromPoint(event.clientX, event.clientY);
      const chip = element?.closest(".project-chip[data-project-id], .project-clear[data-project-id]");
      if (!chip) {
        return null;
      }
      const projectId = chip.dataset.projectId || noProjectId;
      return state.projects.find((project) => project.id === projectId) || null;
    }

    function renderTags(thread) {
      const row = document.createElement("div");
      row.className = "tag-row";
      row.appendChild(folderTag(thread));
      if (thread.git_branch) {
        row.appendChild(branchTag(thread));
      }
      for (const tag of thread.tags || []) {
        row.appendChild(removableTag(thread, tag));
      }
      if (addingTagThreadId === thread.id) {
        const input = document.createElement("input");
        input.className = "tag-input";
        input.placeholder = "Tag";
        input.setAttribute("aria-label", "New tag");
        input.addEventListener("click", (event) => event.stopPropagation());
        let finished = false;
        const finish = (save) => {
          if (finished) {
            return;
          }
          finished = true;
          const value = input.value.trim();
          addingTagThreadId = null;
          if (save && value) {
            vscode.postMessage({ type: "addTag", threadId: thread.id, tag: value });
          }
          render();
        };
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            finish(true);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            finish(false);
          }
        });
        input.addEventListener("blur", () => finish(true));
        row.appendChild(input);
      } else {
        const add = document.createElement("button");
        add.type = "button";
        add.className = "tag-add";
        add.title = "Add tag";
        add.appendChild(icon("plus"));
        add.addEventListener("click", (event) => {
          event.stopPropagation();
          addingTagThreadId = thread.id;
          render();
          focusSelector(".tag-input");
        });
        row.appendChild(add);
      }
      return row;
    }

    function folderTag(thread) {
      const tag = document.createElement("span");
      tag.className = "tag-pill fixed";
      tag.title = thread.cwd || "";
      tag.style.setProperty("--tag-color", thread.cwd_color || "var(--vscode-descriptionForeground)");
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      const text = document.createElement("span");
      text.className = "tag-text";
      text.textContent = thread.cwd_label || "(no folder)";
      tag.append(swatch, text);
      return tag;
    }

    function branchTag(thread) {
      const tag = document.createElement("span");
      tag.className = "tag-pill fixed";
      tag.title = "Git branch: " + thread.git_branch;
      tag.style.setProperty("--tag-color", thread.git_branch_color || "var(--vscode-descriptionForeground)");
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      const text = document.createElement("span");
      text.className = "tag-text";
      text.textContent = thread.git_branch;
      tag.append(swatch, text);
      return tag;
    }

    function removableTag(thread, tagValue) {
      const tag = document.createElement("span");
      tag.className = "tag-pill";
      const text = document.createElement("span");
      text.className = "tag-text";
      text.textContent = tagValue;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "tag-remove";
      remove.title = "Remove tag";
      remove.appendChild(icon("x"));
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        vscode.postMessage({ type: "removeTag", threadId: thread.id, tag: tagValue });
      });
      tag.append(text, remove);
      return tag;
    }

    function renderSearchResults() {
      const query = (state.searchQuery || "").trim();
      if (!query) {
        return;
      }
      const heading = document.createElement("div");
      heading.className = "section-heading";
      heading.textContent = 'Search Results: "' + query + '"';
      chatListRoot.appendChild(heading);

      const results = filteredSearchResults();
      if (!results.length) {
        const empty = document.createElement("div");
        empty.className = "empty-list";
        empty.textContent = "No full-text results.";
        chatListRoot.appendChild(empty);
        return;
      }

      for (const group of groupThreadsByTimeline(results)) {
        const projectHeading = document.createElement("div");
        projectHeading.className = "project-result-heading";
        projectHeading.textContent = timelineHeading(group);
        chatListRoot.appendChild(projectHeading);
        for (const thread of group.threads) {
          chatListRoot.appendChild(renderCard(thread));
        }
      }
    }

    function filteredSearchResults() {
      const projectIds = searchProjectIds();
      return (state.searchResults || []).filter((thread) => projectIds.has(projectIdForThread(thread)));
    }

    function searchProjectIds() {
      const query = projectFilter.trim().toLowerCase();
      const ids = new Set();
      for (const project of state.projects) {
        if (!query || (project.id !== noProjectId && project.name.toLowerCase().includes(query))) {
          ids.add(project.id);
        }
      }
      return ids;
    }

    function projectIdForThread(thread) {
      const known = new Set(state.projects.map((project) => project.id));
      return known.has(thread.project_id) ? thread.project_id : noProjectId;
    }

    function groupThreadsByTimeline(threads) {
      const projects = new Map(state.projects.map((project) => [project.id, project]));
      const groups = [];
      const sortedThreads = [...threads].sort((left, right) => threadTime(right) - threadTime(left));
      for (const thread of sortedThreads) {
        const projectId = projectIdForThread(thread);
        const project = projects.get(projectId) || { id: noProjectId, name: "No Project" };
        const lastGroup = groups[groups.length - 1];
        if (!lastGroup || lastGroup.project.id !== projectId) {
          groups.push({ project, threads: [thread] });
        } else {
          lastGroup.threads.push(thread);
        }
      }
      return groups;
    }

    function timelineHeading(group) {
      const range = dateRange(group.threads);
      if (group.project.id === noProjectId) {
        return range;
      }
      return range + " · " + group.project.name;
    }

    function threadTime(thread) {
      return thread.recency_at_ms || thread.updated_at_ms || (thread.recency_at || thread.updated_at || 0) * 1000;
    }

    function dateRange(threads) {
      const times = threads.map(threadTime).filter(Boolean);
      if (!times.length) {
        return "Unknown date";
      }
      const oldest = new Date(Math.min(...times));
      const newest = new Date(Math.max(...times));
      if (sameDay(oldest, newest)) {
        return sectionDate(newest);
      }
      return sectionDate(oldest) + " - " + sectionDate(newest);
    }

    function sameDay(left, right) {
      return left.getFullYear() === right.getFullYear() &&
        left.getMonth() === right.getMonth() &&
        left.getDate() === right.getDate();
    }

    function sectionDate(date) {
      const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const months = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];
      return weekdays[date.getDay()] + " " + date.getDate() + " " + months[date.getMonth()];
    }

    function focusSelector(selector) {
      window.setTimeout(() => {
        const input = document.querySelector(selector);
        if (!input) {
          return;
        }
        input.focus();
        if (typeof input.select === "function") {
          input.select();
        }
      }, 0);
    }

    function selectProject(projectId) {
      selectedProjectId = projectId || noProjectId;
      render();
    }

    function filteredThreads() {
      const lowerTitleFilter = titleFilter.trim().toLowerCase();
      return state.threads
        .filter((thread) => {
          if ((thread.project_id || noProjectId) !== selectedProjectId) {
            return false;
          }
          if (!lowerTitleFilter) {
            return true;
          }
          return (thread.title || "").toLowerCase().includes(lowerTitleFilter);
        })
        .sort((left, right) => Number(Boolean(right.starred)) - Number(Boolean(left.starred)) || threadTime(right) - threadTime(left));
    }

    function countByProject() {
      const counts = new Map();
      for (const project of state.projects) {
        counts.set(project.id, 0);
      }
      for (const thread of state.threads) {
        const projectId = counts.has(thread.project_id) ? thread.project_id : noProjectId;
        counts.set(projectId, (counts.get(projectId) || 0) + 1);
      }
      return counts;
    }

    function pruneSelections() {
      const known = new Set(state.projects.map((project) => project.id));
      if (!known.has(selectedProjectId)) {
        selectedProjectId = noProjectId;
      }
    }

    function metaItem(text) {
      const item = document.createElement("span");
      item.textContent = text;
      return item;
    }

    function iconButton(iconName, title, onClick, className) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = className;
      button.title = title;
      button.setAttribute("aria-label", title);
      button.appendChild(icon(iconName));
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        onClick();
      });
      return button;
    }

    function confirmButton(onClick, className = "confirm-action") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = className;
      button.textContent = "Confirm";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        onClick();
      });
      return button;
    }

    function installIcon(id, iconName) {
      const button = document.getElementById(id);
      button.textContent = "";
      button.appendChild(icon(iconName));
    }

    function cssEscape(value) {
      if (window.CSS && typeof window.CSS.escape === "function") {
        return window.CSS.escape(value);
      }
      return String(value).replace(/"/g, "\\\"");
    }

    function icon(name) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "icon");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      const parts = iconParts(name);
      for (const part of parts) {
        const element = document.createElementNS("http://www.w3.org/2000/svg", part[0]);
        for (const [key, value] of Object.entries(part[1])) {
          element.setAttribute(key, value);
        }
        svg.appendChild(element);
      }
      return svg;
    }

    function iconParts(name) {
      const icons = {
        archive: [
          ["rect", { x: "4", y: "5", width: "16", height: "4", rx: "1" }],
          ["path", { d: "M6 9v9a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9" }],
          ["path", { d: "M10 13h4" }],
        ],
        "chevron-down": [["path", { d: "m7 10 5 5 5-5" }]],
        "chevron-up": [["path", { d: "m7 14 5-5 5 5" }]],
        edit: [
          ["path", { d: "M4 20h4L18.5 9.5a2.1 2.1 0 0 0-4-4L4 16v4Z" }],
          ["path", { d: "m13.5 6.5 4 4" }],
        ],
        file: [
          ["path", { d: "M7 3h7l4 4v14H7z" }],
          ["path", { d: "M14 3v5h5" }],
          ["path", { d: "M9 13h6" }],
          ["path", { d: "M9 17h4" }],
        ],
        folder: [
          ["path", { d: "M3 6h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" }],
          ["path", { d: "M3 10h18" }],
        ],
        "folder-minus": [
          ["path", { d: "M3 6h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" }],
          ["path", { d: "M3 10h18" }],
          ["path", { d: "M9 15h6" }],
        ],
        plus: [
          ["path", { d: "M12 5v14" }],
          ["path", { d: "M5 12h14" }],
        ],
        refresh: [
          ["path", { d: "M20 12a8 8 0 1 1-2.34-5.66" }],
          ["path", { d: "M20 4v6h-6" }],
        ],
        search: [
          ["circle", { cx: "10.5", cy: "10.5", r: "6.5" }],
          ["path", { d: "m16 16 4 4" }],
        ],
        star: [
          ["path", { d: "m12 3 2.78 5.63 6.22.9-4.5 4.39 1.06 6.19L12 17.18l-5.56 2.93 1.06-6.19L3 9.53l6.22-.9z" }],
        ],
        "star-filled": [
          [
            "path",
            {
              d: "m12 3 2.78 5.63 6.22.9-4.5 4.39 1.06 6.19L12 17.18l-5.56 2.93 1.06-6.19L3 9.53l6.22-.9z",
              fill: "currentColor",
            },
          ],
        ],
        trash: [
          ["path", { d: "M4 7h16" }],
          ["path", { d: "M9 7V5h6v2" }],
          ["path", { d: "M7 7l1 13h8l1-13" }],
          ["path", { d: "M10 11v5" }],
          ["path", { d: "M14 11v5" }],
        ],
        unarchive: [
          ["rect", { x: "4", y: "5", width: "16", height: "4", rx: "1" }],
          ["path", { d: "M6 9v9a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9" }],
          ["path", { d: "m12 17-3-3" }],
          ["path", { d: "m12 17 3-3" }],
          ["path", { d: "M12 17v-6" }],
        ],
        x: [
          ["path", { d: "M6 6l12 12" }],
          ["path", { d: "M18 6 6 18" }],
        ],
      };
      return icons[name] || icons.file;
    }

    function dragGhost(thread) {
      const ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.appendChild(icon("file"));
      const title = document.createElement("span");
      title.className = "drag-ghost-title";
      title.textContent = thread.title || "(untitled)";
      ghost.appendChild(title);
      return ghost;
    }

    function clearDragTargets() {
      for (const element of document.querySelectorAll(".project-chip.drag-over, .project-clear.drag-over")) {
        element.classList.remove("drag-over");
      }
    }

    function formatDate(value) {
      if (!value) {
        return "Unknown";
      }
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return "Unknown";
      }
      return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    }

    function formatSize(value) {
      if (value === null || value === undefined) {
        return "Unknown size";
      }
      if (value < 1024) {
        return value + " B";
      }
      const units = ["KB", "MB", "GB"];
      let size = value / 1024;
      let unit = 0;
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit += 1;
      }
      return size.toFixed(size >= 10 ? 0 : 1) + " " + units[unit];
    }
  </script>
</body>
</html>`;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Codex Chat Organizer");
  context.subscriptions.push(output);
  output.appendLine(`[${new Date().toISOString()}] Activating Codex Chat Organizer ${context.extension.packageJSON.version}`);

  const provider = new CodexChatOrganizerView(context, output);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(CodexChatOrganizerView.viewType, provider));

  context.subscriptions.push(
    vscode.commands.registerCommand("codexChatOrganizer.refresh", async () => {
      await provider.refresh();
    }),
    vscode.commands.registerCommand("codexChatOrganizer.search", async () => {
      const query = await vscode.window.showInputBox({
        title: "Search Codex Chats",
        prompt: "Search titles, metadata, projects, tags, and transcript content.",
        value: provider.activeQuery,
      });
      if (query !== undefined) {
        await provider.search(query.trim());
      }
    }),
    vscode.commands.registerCommand("codexChatOrganizer.clearSearch", async () => {
      await provider.search("");
    }),
    vscode.commands.registerCommand("codexChatOrganizer.createProject", async () => {
      await provider.createProject();
    }),
    vscode.commands.registerCommand("codexChatOrganizer.checkCompatibility", async () => {
      await provider.checkCompatibility(true);
    }),
    vscode.commands.registerCommand("codexChatOrganizer.showDiagnostics", () => {
      output.show();
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration("codexChatOrganizer")) {
        await provider.refresh();
      }
    }),
  );
}

export function deactivate(): void {}

async function mutateCodexState(
  context: vscode.ExtensionContext,
  args: string[],
  output?: vscode.OutputChannel,
): Promise<HelperResponse> {
  const response = await runHelper<HelperResponse>(context, args, output);
  const backup = typeof response.backup_dir === "string" ? response.backup_dir : undefined;
  if (backup) {
    output?.appendLine(`[${new Date().toISOString()}] Codex state backup: ${backup}`);
  }
  return response;
}

async function runHelper<T extends HelperResponse>(
  context: vscode.ExtensionContext,
  args: string[],
  output?: vscode.OutputChannel,
): Promise<T> {
  const helperPath = context.asAbsolutePath(path.join("scripts", "codex_state.py"));
  const codexHome = vscode.workspace.getConfiguration("codexChatOrganizer").get<string>("codexHome", "").trim();
  const helperArgs = [...(codexHome ? ["--codex-home", codexHome] : []), ...args];
  const errors: string[] = [];

  for (const python of pythonCandidates()) {
    try {
      output?.appendLine(
        `[${new Date().toISOString()}] Running helper: ${python} ${[helperPath, ...redactArgs(helperArgs)].join(" ")}`,
      );
      const stdout = await execFile(python, [helperPath, ...helperArgs]);
      let parsed: T;
      try {
        parsed = JSON.parse(stdout) as T;
      } catch (error) {
        throw new Error(`Helper returned invalid JSON: ${errorMessage(error)}\n${stdout.slice(0, 2000)}`);
      }
      if (!parsed.ok && parsed.error) {
        throw new Error(parsed.error);
      }
      return parsed;
    } catch (error) {
      errors.push(`${python}: ${errorMessage(error)}`);
    }
  }

  throw new Error(`Could not run Codex Chat Organizer helper.\n${errors.join("\n")}`);
}

function redactArgs(args: string[]): string[] {
  const redactedAfter = new Set(["--query", "--tags", "--title", "--name"]);
  return args.map((arg, index) => (redactedAfter.has(args[index - 1]) ? "<redacted>" : arg));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

function pythonCandidates(): string[] {
  const configured = vscode.workspace.getConfiguration("codexChatOrganizer").get<string>("pythonPath", "").trim();
  if (configured) {
    return [configured];
  }
  return process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
}

function execFile(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile(command, args, { maxBuffer: 200 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = stdout.trim() || stderr.trim() || error.message;
        reject(new Error(detail));
        return;
      }
      resolve(stdout);
    });
  });
}

function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let index = 0; index < 32; index += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
