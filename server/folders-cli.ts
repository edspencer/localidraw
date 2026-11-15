// `localidraw add <path> [--name <n>]`, `localidraw remove <name|path>` and `localidraw folders`: they edit (or read)
// ~/.localidraw/config.json, so no server needs to be running; one that is follows the file (server.ts).
import { EXIT } from "./contract/exit-codes.ts";
import { createOutput, UsageError } from "./contract/output.ts";
import { addFolder, configPath, FolderError, isThere, readConfig, removeFolder, SCRATCH, scratchDir } from "./folders.ts";

export const ADD_USAGE = `Usage: localidraw add <folder> [--name <name>] [--json]
`;
export const REMOVE_USAGE = `Usage: localidraw remove <name|folder> [--json]
`;
export const FOLDERS_USAGE = `Usage: localidraw folders [--json]
`;

const ADD_HELP = `localidraw add: serve a folder's canvases too, in the Localidraw that serves the list

${ADD_USAGE}
  --name <name>     its name in the sidebar and the URL (default: the folder's own name). Letters, digits,
                    - and _; never "${SCRATCH}", and no two alike.
  --json            one JSON document on stdout

It's added to ~/.localidraw/config.json, and a running Localidraw shows it at once: no restart. It refuses a
folder that's listed already, one inside or holding a listed folder (so no canvas shows twice), and one inside
~/.localidraw. \`localidraw remove\` takes it out again; nothing in the folder is touched.
`;

const REMOVE_HELP = `localidraw remove: stop serving a folder (its canvases stay where they are)

${REMOVE_USAGE}
  --json            one JSON document on stdout

Give its name (\`localidraw folders\` lists them) or its path. Scratch can't be removed.
`;

const FOLDERS_HELP = `localidraw folders: the folders the Localidraw that serves the list serves

${FOLDERS_USAGE}
  --json            one JSON document on stdout

Scratch (~/.localidraw/drawings) comes first, then each listed folder, marked missing if it isn't there now
(it stays listed, and shows again once it's back). The list is ~/.localidraw/config.json.
`;

type Parsed = { positional: string[]; name?: string; json: boolean; help: boolean };

function parse(rest: string[], takesName: boolean): Parsed {
  const p: Parsed = { positional: [], json: false, help: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "-h" || a === "--help") p.help = true;
    else if (a === "--json") p.json = true;
    else if (takesName && a === "--name") {
      if (rest[i + 1] === undefined) throw new UsageError("--name needs a name");
      p.name = rest[++i];
    } else if (takesName && a.startsWith("--name=")) p.name = a.slice("--name=".length);
    else if (a.startsWith("-") && a !== "-") throw new UsageError(`unknown option ${a}`);
    else p.positional.push(a);
  }
  return p;
}

/** Runs `add`, `remove` or `folders` with the arguments after its name, against the home `~/.localidraw`. */
export function runFolders(command: "add" | "remove" | "folders", rest: string[], home: string): number {
  const p = parse(rest, command === "add");
  const out = createOutput({ tool: "localidraw", json: p.json });
  if (p.help) { out.say({ add: ADD_HELP, remove: REMOVE_HELP, folders: FOLDERS_HELP }[command].trimEnd()); return EXIT.OK; }
  const fail = (message: string) => {
    out.result({ ok: false, error: message });
    return out.error(message);
  };

  if (command === "folders") {
    if (p.positional.length) throw new UsageError(`\`folders\` takes no argument (got ${p.positional[0]})`);
    let folders;
    try {
      folders = readConfig(home).folders;
    } catch (err) {
      return fail((err as Error).message);
    }
    const list = folders.map((f) => ({ ...f, missing: !isThere(f.path) }));
    const scratch = { name: SCRATCH, path: scratchDir(home) };
    if (out.json) { out.result({ ok: true, config: configPath(home), scratch, folders: list }); return EXIT.OK; }
    const width = Math.max(SCRATCH.length, ...list.map((f) => f.name.length));
    out.say(`${SCRATCH.padEnd(width)}  ${scratch.path}`);
    for (const f of list) out.say(`${f.name.padEnd(width)}  ${f.path}${f.missing ? "  (missing)" : ""}`);
    if (!list.length) out.say(`\nNo folders listed yet: \`localidraw add <folder>\` adds one.`);
    return EXIT.OK;
  }

  if (p.positional.length !== 1) {
    throw new UsageError(p.positional.length ? `one folder at a time (got ${p.positional.join(" and ")})` : `\`${command}\` needs ${command === "add" ? "a folder" : "a folder's name or path"}`);
  }
  const [which] = p.positional;
  try {
    if (command === "add") {
      const added = addFolder(home, which, p.name);
      out.result({ ok: true, action: "add", folder: added });
      out.say(`Added ${added.path} as ${added.name}. A running Localidraw shows it now; \`localidraw remove ${added.name}\` takes it out.`);
    } else {
      if (which.toLowerCase() === SCRATCH) throw new FolderError("Scratch is always there; it can't be removed");
      const removed = removeFolder(home, which);
      out.result({ ok: true, action: "remove", folder: removed });
      out.say(`Removed ${removed.name} (${removed.path}) from the list. Its canvases are still there.`);
    }
    return EXIT.OK;
  } catch (err) {
    // A refusal (listed already, nested, not a folder) or a config that doesn't parse: nothing was written.
    return fail((err as Error).message);
  }
}
