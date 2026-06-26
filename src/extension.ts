import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

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

interface ThreadRecord {
  id: string;
  title: string;
  cwd: string;
  rollout_path: string;
  archived: boolean;
  archived_at: number | null;
  updated_at: number;
  updated_at_ms: number | null;
  recency_at: number;
  recency_at_ms: number | null;
  first_user_message: string;
  preview: string;
  tags: string[];
  match?: string;
}

interface ListResponse extends HelperResponse {
  schema: SchemaResponse;
  threads: ThreadRecord[];
  query: string;
}

interface TranscriptResponse extends HelperResponse {
  markdown: string;
}

type TreeNode = ProjectNode | ThreadNode;

class ProjectNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly threads: ThreadRecord[],
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${threads.length}`;
    this.contextValue = "project";
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

class ThreadNode extends vscode.TreeItem {
  constructor(public readonly thread: ThreadRecord) {
    super(thread.title || "(untitled)", vscode.TreeItemCollapsibleState.None);
    this.id = thread.id;
    this.description = descriptionForThread(thread);
    this.tooltip = tooltipForThread(thread);
    this.contextValue = thread.archived ? "archivedThread" : "thread";
    this.iconPath = new vscode.ThemeIcon(thread.archived ? "archive" : "comment-discussion");
    this.command = {
      command: "codexChatOrganizer.openTranscript",
      title: "Open Transcript",
      arguments: [this],
    };
  }
}

class CodexThreadProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private threads: ThreadRecord[] = [];
  private query = "";
  private schema: SchemaResponse | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  get activeQuery(): string {
    return this.query;
  }

  async refresh(query = this.query): Promise<void> {
    this.query = query;
    await vscode.commands.executeCommand("setContext", "codexChatOrganizer.hasSearch", Boolean(this.query));
    const config = vscode.workspace.getConfiguration("codexChatOrganizer");
    const includeArchived = config.get<boolean>("showArchived", false);
    const searchContent = config.get<boolean>("searchTranscriptContent", true);
    const args = [
      "list",
      "--limit",
      "500",
      ...(includeArchived ? ["--include-archived"] : []),
      ...(this.query ? ["--query", this.query] : []),
      ...(searchContent ? ["--search-content"] : []),
    ];
    const response = await runHelper<ListResponse>(this.context, args);
    this.schema = response.schema;
    this.threads = response.ok ? response.threads : [];
    if (!response.ok) {
      vscode.window.showWarningMessage(`Codex Chat Organizer is read-only: ${response.schema?.problems?.join("; ") || response.error}`);
    }
    this.emitter.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (element instanceof ProjectNode) {
      return element.threads.map((thread) => new ThreadNode(thread));
    }
    if (element instanceof ThreadNode) {
      return [];
    }
    if (this.query) {
      return this.threads.map((thread) => new ThreadNode(thread));
    }
    return groupByProject(this.threads).map(([project, threads]) => new ProjectNode(project, threads));
  }

  getThreadFromNode(node: ThreadNode | undefined): ThreadRecord | undefined {
    return node?.thread;
  }

  async checkCompatibility(showSuccess: boolean): Promise<boolean> {
    const schema = await runHelper<SchemaResponse>(this.context, ["schema"]);
    this.schema = schema;
    if (schema.ok) {
      if (showSuccess) {
        vscode.window.showInformationMessage(
          `Codex Chat Organizer is compatible. Found ${schema.thread_count ?? 0} threads in ${schema.db_path}.`,
        );
      }
      return true;
    }
    vscode.window.showErrorMessage(`Unsupported Codex state: ${schema.problems.join("; ")}`);
    return false;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const provider = new CodexThreadProvider(context);
  context.subscriptions.push(vscode.window.registerTreeDataProvider("codexChatOrganizer.threads", provider));

  context.subscriptions.push(
    vscode.commands.registerCommand("codexChatOrganizer.refresh", async () => {
      await provider.refresh();
    }),
    vscode.commands.registerCommand("codexChatOrganizer.search", async () => {
      const query = await vscode.window.showInputBox({
        title: "Search Codex Chats",
        prompt: "Search titles, metadata, tags, and transcript content.",
        value: provider.activeQuery,
      });
      if (query !== undefined) {
        await provider.refresh(query.trim());
      }
    }),
    vscode.commands.registerCommand("codexChatOrganizer.clearSearch", async () => {
      await provider.refresh("");
    }),
    vscode.commands.registerCommand("codexChatOrganizer.renameThread", async (node?: ThreadNode) => {
      const thread = requireThread(node);
      if (!thread) {
        return;
      }
      const title = await vscode.window.showInputBox({
        title: "Rename Codex Chat",
        prompt: "This updates Codex local state and should appear in the Codex extension.",
        value: thread.title,
        validateInput: (value) => (value.trim() ? undefined : "Title cannot be empty."),
      });
      if (title === undefined) {
        return;
      }
      await mutateCodexState(context, ["rename", "--thread-id", thread.id, "--title", title.trim()]);
      await provider.refresh();
    }),
    vscode.commands.registerCommand("codexChatOrganizer.archiveThread", async (node?: ThreadNode) => {
      const thread = requireThread(node);
      if (!thread) {
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `Archive "${thread.title}" in Codex?`,
        { modal: false },
        "Archive",
      );
      if (answer !== "Archive") {
        return;
      }
      await mutateCodexState(context, ["archive", "--thread-id", thread.id, "--archived", "true"]);
      await provider.refresh();
    }),
    vscode.commands.registerCommand("codexChatOrganizer.unarchiveThread", async (node?: ThreadNode) => {
      const thread = requireThread(node);
      if (!thread) {
        return;
      }
      await mutateCodexState(context, ["archive", "--thread-id", thread.id, "--archived", "false"]);
      await provider.refresh();
    }),
    vscode.commands.registerCommand("codexChatOrganizer.setTags", async (node?: ThreadNode) => {
      const thread = requireThread(node);
      if (!thread) {
        return;
      }
      const tags = await vscode.window.showInputBox({
        title: "Set Organizer Tags",
        prompt: "Comma-separated tags. Tags are stored in ~/.codex-chat-organizer, not Codex state.",
        value: thread.tags.join(", "),
      });
      if (tags === undefined) {
        return;
      }
      await runHelper<HelperResponse>(context, ["set-tags", "--thread-id", thread.id, "--tags", tags]);
      await provider.refresh();
    }),
    vscode.commands.registerCommand("codexChatOrganizer.openTranscript", async (node?: ThreadNode) => {
      const thread = requireThread(node);
      if (!thread) {
        return;
      }
      const response = await runHelper<TranscriptResponse>(context, ["transcript", "--thread-id", thread.id]);
      const document = await vscode.workspace.openTextDocument({
        content: response.markdown,
        language: "markdown",
      });
      await vscode.window.showTextDocument(document, { preview: true });
    }),
    vscode.commands.registerCommand("codexChatOrganizer.resumeThread", async (node?: ThreadNode) => {
      const thread = requireThread(node);
      if (!thread) {
        return;
      }
      const terminal = vscode.window.createTerminal({ name: `Codex: ${thread.title.slice(0, 32)}` });
      terminal.show();
      terminal.sendText(`codex resume ${thread.id}`);
    }),
    vscode.commands.registerCommand("codexChatOrganizer.copySessionId", async (node?: ThreadNode) => {
      const thread = requireThread(node);
      if (!thread) {
        return;
      }
      await vscode.env.clipboard.writeText(thread.id);
      vscode.window.showInformationMessage("Copied Codex session ID.");
    }),
    vscode.commands.registerCommand("codexChatOrganizer.checkCompatibility", async () => {
      await provider.checkCompatibility(true);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration("codexChatOrganizer")) {
        await provider.refresh();
      }
    }),
  );

  await provider.checkCompatibility(false);
  await provider.refresh();
}

export function deactivate(): void {}

function requireThread(node?: ThreadNode): ThreadRecord | undefined {
  if (node instanceof ThreadNode) {
    return node.thread;
  }
  vscode.window.showWarningMessage("Pick a Codex chat from the Codex Chats tree first.");
  return undefined;
}

async function mutateCodexState(context: vscode.ExtensionContext, args: string[]): Promise<void> {
  const response = await runHelper<HelperResponse>(context, args);
  const backup = typeof response.backup_dir === "string" ? response.backup_dir : undefined;
  vscode.window.showInformationMessage(`Codex state updated.${backup ? ` Backup: ${backup}` : ""}`);
}

function descriptionForThread(thread: ThreadRecord): string {
  const parts: string[] = [];
  if (thread.tags.length) {
    parts.push(thread.tags.map((tag) => `#${tag}`).join(" "));
  }
  if (thread.match) {
    parts.push(thread.match);
  } else {
    parts.push(shortProject(thread.cwd));
  }
  return parts.join(" | ");
}

function tooltipForThread(thread: ThreadRecord): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.appendMarkdown(`**${escapeMarkdown(thread.title || "(untitled)")}**\n\n`);
  tooltip.appendMarkdown(`- Session: \`${thread.id}\`\n`);
  tooltip.appendMarkdown(`- CWD: \`${thread.cwd}\`\n`);
  tooltip.appendMarkdown(`- Archived: \`${thread.archived}\`\n`);
  if (thread.tags.length) {
    tooltip.appendMarkdown(`- Tags: ${thread.tags.map((tag) => `\`${tag}\``).join(", ")}\n`);
  }
  if (thread.match) {
    tooltip.appendMarkdown(`\n${escapeMarkdown(thread.match)}\n`);
  }
  tooltip.appendMarkdown(`\nRollout: \`${thread.rollout_path}\``);
  return tooltip;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&");
}

function groupByProject(threads: ThreadRecord[]): Array<[string, ThreadRecord[]]> {
  const groups = new Map<string, ThreadRecord[]>();
  for (const thread of threads) {
    const project = projectLabel(thread.cwd);
    const existing = groups.get(project);
    if (existing) {
      existing.push(thread);
    } else {
      groups.set(project, [thread]);
    }
  }
  return [...groups.entries()];
}

function projectLabel(cwd: string): string {
  if (!cwd) {
    return "(no project)";
  }
  const base = path.basename(cwd);
  return base || cwd;
}

function shortProject(cwd: string): string {
  if (!cwd) {
    return "";
  }
  const parent = path.basename(path.dirname(cwd));
  const base = path.basename(cwd);
  return parent ? `${parent}/${base}` : base;
}

async function runHelper<T extends HelperResponse>(context: vscode.ExtensionContext, args: string[]): Promise<T> {
  const helperPath = context.asAbsolutePath(path.join("scripts", "codex_state.py"));
  const codexHome = vscode.workspace.getConfiguration("codexChatOrganizer").get<string>("codexHome", "").trim();
  const helperArgs = [...(codexHome ? ["--codex-home", codexHome] : []), ...args];
  const errors: string[] = [];

  for (const python of pythonCandidates()) {
    try {
      const stdout = await execFile(python, [helperPath, ...helperArgs]);
      const parsed = JSON.parse(stdout) as T;
      if (!parsed.ok && parsed.error) {
        throw new Error(parsed.error);
      }
      return parsed;
    } catch (error) {
      errors.push(`${python}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Could not run Codex Chat Organizer helper.\n${errors.join("\n")}`);
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
