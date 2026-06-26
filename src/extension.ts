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

type TreeNode = ProjectNode | ThreadNode | StatusNode;

class StatusNode extends vscode.TreeItem {
  constructor(label: string, description: string | undefined, icon: string, command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = "status";
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = command;
  }
}

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
  private statusMessage: string | null = "Loading Codex chats...";
  private errorMessage: string | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  get activeQuery(): string {
    return this.query;
  }

  async refresh(query = this.query): Promise<void> {
    this.query = query;
    this.statusMessage = "Loading Codex chats...";
    this.errorMessage = null;
    this.emitter.fire();

    await vscode.commands.executeCommand("setContext", "codexChatOrganizer.hasSearch", Boolean(this.query));
    const config = vscode.workspace.getConfiguration("codexChatOrganizer");
    const includeArchived = config.get<boolean>("showArchived", false);
    const searchContent = config.get<boolean>("searchTranscriptContent", true);
    this.log(
      `Refreshing chats: includeArchived=${includeArchived}, searchContent=${searchContent}, query=${
        this.query ? "<set>" : "<empty>"
      }`,
    );
    const args = [
      "list",
      "--limit",
      "500",
      ...(includeArchived ? ["--include-archived"] : []),
      ...(this.query ? ["--query", this.query] : []),
      ...(searchContent ? ["--search-content"] : []),
    ];
    try {
      const response = await runHelper<ListResponse>(this.context, args, this.output);
      this.schema = response.schema;
      this.threads = response.ok ? response.threads : [];
      if (response.ok) {
        this.statusMessage = this.threads.length ? null : "No Codex chats found.";
        this.log(`Loaded ${this.threads.length} chat(s).`);
      } else {
        this.errorMessage = response.schema?.problems?.join("; ") || response.error || "Unknown helper error.";
        this.statusMessage = "Could not load Codex chats.";
        this.log(`Helper returned not ok: ${this.errorMessage}`);
        vscode.window.showWarningMessage(`Codex Chat Organizer is read-only: ${this.errorMessage}`);
      }
    } catch (error) {
      this.threads = [];
      this.errorMessage = errorMessage(error);
      this.statusMessage = "Could not load Codex chats.";
      this.log(`Refresh failed:\n${errorDetails(error)}`);
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
    if (element instanceof StatusNode) {
      return [];
    }
    if (this.errorMessage) {
      return [
        new StatusNode("Could not load Codex chats", this.errorMessage, "warning", {
          command: "codexChatOrganizer.showDiagnostics",
          title: "Show Diagnostics",
        }),
      ];
    }
    if (!this.threads.length) {
      return [
        new StatusNode(this.statusMessage || "No Codex chats found", "Open diagnostics for details", "info", {
          command: "codexChatOrganizer.showDiagnostics",
          title: "Show Diagnostics",
        }),
      ];
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
      vscode.window.showErrorMessage(`Unsupported Codex state: ${details}`);
      return false;
    } catch (error) {
      this.log(`Compatibility check failed:\n${errorDetails(error)}`);
      if (showSuccess) {
        vscode.window.showErrorMessage(`Could not check Codex compatibility: ${errorMessage(error)}`);
      }
      return false;
    }
  }

  private log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Codex Chat Organizer");
  context.subscriptions.push(output);
  output.appendLine(`[${new Date().toISOString()}] Activating Codex Chat Organizer ${context.extension.packageJSON.version}`);

  const provider = new CodexThreadProvider(context, output);
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
      await mutateCodexState(context, ["rename", "--thread-id", thread.id, "--title", title.trim()], output);
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
      await mutateCodexState(context, ["archive", "--thread-id", thread.id, "--archived", "true"], output);
      await provider.refresh();
    }),
    vscode.commands.registerCommand("codexChatOrganizer.unarchiveThread", async (node?: ThreadNode) => {
      const thread = requireThread(node);
      if (!thread) {
        return;
      }
      await mutateCodexState(context, ["archive", "--thread-id", thread.id, "--archived", "false"], output);
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
      await runHelper<HelperResponse>(context, ["set-tags", "--thread-id", thread.id, "--tags", tags], output);
      await provider.refresh();
    }),
    vscode.commands.registerCommand("codexChatOrganizer.openTranscript", async (node?: ThreadNode) => {
      const thread = requireThread(node);
      if (!thread) {
        return;
      }
      const response = await runHelper<TranscriptResponse>(context, ["transcript", "--thread-id", thread.id], output);
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

async function mutateCodexState(
  context: vscode.ExtensionContext,
  args: string[],
  output?: vscode.OutputChannel,
): Promise<void> {
  const response = await runHelper<HelperResponse>(context, args, output);
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
      errors.push(`${python}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Could not run Codex Chat Organizer helper.\n${errors.join("\n")}`);
}

function redactArgs(args: string[]): string[] {
  const redactedAfter = new Set(["--query", "--tags", "--title"]);
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
