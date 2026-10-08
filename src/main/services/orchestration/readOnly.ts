// 1.5.13: is a shell command line only reading? Used for one button of a permission prompt — "allow read-only commands
// until the run ends" — so it says yes only for what it fully understands, and no for everything else: a command it does
// not know, a write (any redirection but to /dev/null), a command substitution, a subshell or a function, a background
// job, an option that runs or writes something (find -exec, rg --pre, sort -o, sed other than "-n <lines>p").
// git is never read-only here: its configuration (core.fsmonitor, diff drivers, pagers) can run any program, and the
// agent may have written that configuration in the work folder.

// dynamic: has a $variable, its value is not known before it runs; expands: an unquoted *, ?, [ or { — the shell turns
// it into file names (or several words), and the agent names the files in the work folder: "-i" or "--pre=./x"
interface Word { text: string; dynamic: boolean; expands?: boolean }
type Segment = Word[];

const SEPARATORS = ["&&", "||", ";", "|", "\n"];

// Splits into simple commands; null when the line uses anything this reader does not take.
function segments(line: string): Segment[] | null {
  const out: Segment[] = [];
  let words: Word[] = [];
  let cur: Word | null = null;
  const word = () => (cur ??= { text: "", dynamic: false });
  const endWord = () => { if (cur) { words.push(cur); cur = null; } };
  const endSegment = () => { endWord(); out.push(words); words = []; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const sep = SEPARATORS.find((s) => line.startsWith(s, i));
    if (sep) { endSegment(); i += sep.length - 1; continue; }
    if (c === " " || c === "\t") { endWord(); continue; }
    // read differently by an interactive shell and a script: # starts a comment only with interactive_comments (zsh),
    // ! and ^ expand the history. None of them is taken outside single quotes.
    if ((c === "#" && cur === null) || c === "!" || c === "^") return null;
    // outside quotes a backslash only joins lines; anything else it escapes is refused (one rule less to read alike)
    if (c === "\\") {
      if (line[i + 1] === "\n") { i++; continue; }
      return null;
    }
    // control characters (carriage return, vertical tab, NUL…) are read differently by different shells
    if (c < " " && c !== "\n") return null;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return null;
      word().text += line.slice(i + 1, end);
      i = end;
      continue;
    }
    if (c === "\"") {
      let j = i + 1;
      for (; j < line.length && line[j] !== "\""; j++) {
        const d = line[j];
        if (d === "`" || d === "!" || (d === "$" && "({[".includes(line[j + 1] ?? ""))) return null;
        if (d === "\\") { word().text += line[j + 1] ?? ""; j++; continue; }
        if (d === "$") word().dynamic = true;
        word().text += d;
      }
      if (j >= line.length) return null;
      i = j;
      continue;
    }
    // a background job, a subshell, a substitution, input from a file or a here-document (2>&1 is taken with ">" below)
    if (c === "`" || c === "(" || c === ")" || c === "&" || c === "<") return null;
    // ${…} may run commands (zsh ${(e)x}, bash ${x@P}); $[…] is arithmetic that may too; $'…' and $"…" quote by
    // other rules (\' does not end $'…'): only a plain $name or $@
    if (c === "$") {
      if ("({['\"".includes(line[i + 1] ?? "")) return null;
      word().dynamic = true;
    }
    if (c === ">") {
      // only into /dev/null or another descriptor
      endWordIfNotFd();
      const rest = line.slice(i + 1).replace(/^>/, "").trimStart();
      // >&2 only when the digits end the word: >&2foo is a file named "2foo" to bash
      const fd = /^&\d+(?=$|[\s;|])/.exec(rest);
      const target = fd ? fd[0] : /^\/dev\/null(?=$|[\s;&|])/.exec(rest)?.[0];
      if (!target) return null;
      i = line.indexOf(target, i + 1) + target.length - 1;
      cur = null;
      continue;
    }
    if ("*?[{".includes(c)) word().expands = true;
    word().text += c;
  }
  endSegment();
  return out.filter((s) => s.length > 0);

  function endWordIfNotFd(): void { if (cur && /^\d+$/.test(cur.text)) cur = null; else endWord(); }
}

const PLAIN = new Set(["cat", "head", "tail", "wc", "ls", "pwd", "echo", "printf", "true", "stat", "basename", "dirname",
  "realpath", "nl", "cut", "tr", "cmp", "diff", "du", "which", "type", "cd", "grep", "egrep", "fgrep", "rg", "sed", "find", "sort", "uniq"]);
// where a $variable or a pattern may stand in the arguments: none of their options runs, writes or sets anything
const DYNAMIC_ARGS = new Set(["cat", "head", "tail", "wc", "ls", "echo", "cd", "grep", "egrep", "fgrep", "stat", "basename", "dirname", "realpath",
  "nl", "cut", "tr", "cmp", "diff", "du", "which", "type", "pwd", "true"]);
const FIND_ACTIONS = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;
const SHELLS = new Set(["bash", "sh", "zsh"]);
// A shell variable of the line itself (O="--include=*.py", for f in …): lowercase or one capital letter. Never one the
// shell or a program reads (PATH, IFS, BASH_ENV, LD_*, GIT_*…), nor one zsh ties to them (path, cdpath, fpath…).
const ZSH_TIED = new Set(["path", "cdpath", "fpath", "manpath", "mailpath", "module_path"]);
const plainVariable = (name: string): boolean => (/^[a-z_][a-z0-9_]*$/.test(name) || /^[A-Z]$/.test(name)) && !ZSH_TIED.has(name);

function commandReadOnly(seg: Segment, depth: number): boolean {
  let words = seg;
  if (words[0]?.text === "do" || words[0]?.text === "then") words = words.slice(1);
  if (words.length === 1 && (words[0].text === "done" || words[0].text === "fi")) return true;
  // NAME=value alone sets a variable of this line; before a command it is that command's environment: never read-only
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/;
  if (words.every((w) => assignment.test(w.text))) return words.every((w) => plainVariable(assignment.exec(w.text)![1]));
  if (assignment.test(words[0].text)) return false;
  const [head, ...args] = words;
  if (head.dynamic) return false;
  const name = head.text;
  if (name === "for") return args.length >= 2 && plainVariable(args[0].text) && args[1].text === "in";
  if (SHELLS.has(name)) {
    // bash -c '<line>': the line it runs is read the same way
    return depth < 2 && args.length === 2 && args[0].text === "-c" && !args[1].dynamic
      ? readOnlyLine(args[1].text, depth + 1) : false;
  }
  if (!PLAIN.has(name)) return false;
  if (!DYNAMIC_ARGS.has(name) && args.some((a) => a.dynamic || a.expands)) return false;
  const texts = args.map((a) => a.text);
  switch (name) {
    case "find": return !texts.some((a) => FIND_ACTIONS.test(a));
    // --pre and --hostname-bin run a program, -z/--search-zip runs decompressors
    case "rg": return !texts.some((a) => a.startsWith("--pre") || a.startsWith("--hostname-bin") || a.startsWith("--search-zip") || /^-[a-zA-Z]*z/.test(a));
    // only the ordering flags: -o writes, --compress-program runs a program
    case "sort": return texts.every((a) => !a.startsWith("-") || /^-([nrufhVbsMgd]+|[kt].*)$/.test(a));
    case "printf": return !texts.includes("-v");
    case "uniq": return texts.filter((a) => !a.startsWith("-")).length <= 1;
    case "sed": {
      const opts = texts.filter((a) => a.startsWith("-"));
      const rest = texts.filter((a) => !a.startsWith("-"));
      return opts.includes("-n") && opts.every((o) => o === "-n" || o === "-E" || o === "-r")
        && rest.length >= 1 && /^(\d+|\$)(,(\d+|\$))?p$/.test(rest[0]);
    }
    default: return true;
  }
}

function readOnlyLine(line: string, depth: number): boolean {
  const segs = segments(line);
  return segs !== null && segs.length > 0 && segs.every((s) => commandReadOnly(s, depth));
}

export function readOnlyCommand(line: string): boolean {
  return line.length <= 20_000 && readOnlyLine(line, 0);
}
