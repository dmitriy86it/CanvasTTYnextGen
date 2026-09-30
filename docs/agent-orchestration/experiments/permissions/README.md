# Эксперименты: git worktree и Seatbelt runner

Среда: macOS 27.0, git 2.50.1 (Apple Git-155), node v26.8.1 arm64, `/usr/bin/sandbox-exec`.
Все файлы — фиктивные, создаются здесь же. Реальные секреты не читаются.
`P` ниже — путь к этой папке (`exp/permissions`). Команды запускать в **bash** (zsh не делит `$VAR` на слова и ломает `+$W:ref` модификатором `:r`).

## 1. Seatbelt runner (`sb/`)

**Что это доказывает и что нет.** Это проверка только runner'а — Seatbelt-профиля для команд проверок (тесты), запускаемых оркестратором. Она **не** доказывает изоляцию Claude Code (его собственный sandbox и файловые инструменты Read/Edit/Write) и **не** доказывает read-only режим Codex: это отдельные механизмы, здесь не запускались.

Файлы:

| Файл | Назначение |
|---|---|
| `runner.sb` | минимальный профиль: без сети (ни localhost, ни внешней), без PTY; deny секретов под `REALHOME`, deny всего `USERDATA` и `SRCREPO`; узкий allow на `runs/<id>/{repo,tmp,home}`; read-only `SRCREPO/node_modules` и `SRCREPO/.git/objects` (alternates от `clone --shared`); stat предков этих путей (`path-ancestors`) |
| `runner-denyhome.sb` | opt-in: deny всего `REALHOME` + повторные узкие allow (run, deps, `TOOLCHAIN` read-only) |
| `runner-localhost.sb` | opt-in: TCP только `localhost:PORT` |
| `runner-unix.sb` | opt-in: unix-сокеты только внутри `TMP` |
| `runner-pty.sb` | opt-in: `/dev/ptmx` + `/dev/ttys*` |
| `sb.sh` | обёртка: проверяет, что пути существуют и разрешены (`pwd -P`, иначе rc=2 — Seatbelt сравнивает реальные пути, `/tmp` ≠ `/private/tmp`), склеивает `runner.sb` + `runner-$EXTRAS.sb`, `cd` в копию, `sandbox-exec -p … -D …` → `/usr/bin/env -i HOME=<run>/home PATH=[TOOLCHAIN/bin:]/usr/bin:/bin TMPDIR=<run>/tmp LANG=C` → команда |
| `probe.sh` | матрица из 39 проверок (`deny.*`/`allow.*`) + имена env + HOME; rc=2 при пустом аргументе |
| `validate.sh` | строит одноразовую фикстуру, гоняет положительный контроль вне песочницы и те же проверки внутри (прямо, внук, detached), opt-in профили; rc≠0 при любом несовпадении или непрошедшем контроле; фикстура удаляется (`KEEP=1` — оставить) |
| `net.cjs`, `detach.cjs` | сетевые пробы; detached-потомок (новый pgid, родитель выходит). `.cjs`: корневой `package.json` имеет `"type":"module"`, прежний `net.js` падал с `require is not defined` — значит, прежние «denied» для сети были недостоверны |
| `results-runner.txt` | вывод последнего прогона `validate.sh` (пути санитизированы) |

Запуск (bash):

```bash
bash "$P/sb/validate.sh" <временный каталог>     # rc=0 и "== result: PASS"
# одиночная команда:
USERDATA=<userData> RUN_ID=<id> REALHOME=<home> SRCREPO=<repo> TOOLCHAIN=<node-prefix> \
  [EXTRAS="denyhome localhost unix pty"] [PORT=<n>] bash "$P/sb/sb.sh" node --test ...
```

Фикстура (`<tmp>/CTTYEXP-fx.XXXX`, всё `FAKE-…`): `realhome/{.ssh/id_ed25519,.aws/credentials,.codex/auth.json,.claude/.credentials.json,.claude.json,.config/gh/hosts.yml,.npmrc,.gitconfig,.config/git/config,Library/Keychains/login.keychain-db,.netrc,.docker/config.json,.kube/config,.gnupg/pubring.kbx,notes.txt}`; `USERDATA=realhome/Library/Application Support/CanvasTTY` с `state.json`, `runs/r1/{repo,tmp,home}`, `runs/other/repo`; `SRCREPO=realhome/dev/proj` (git + `node_modules`); копия — `git clone --shared` + symlink `node_modules`; `outside/`.

Результат (`results-runner.txt`), кратко:

- Контроль вне песочницы: все 39 проверок `ALLOWED`, в env видны `FAKE_PARENT_TOKEN`, `ELECTRON_RUN_AS_NODE`.
- `runner.sb` и `runner.sb+denyhome`, для прямого запуска, внука (`sh -c 'sh -c …'`) и detached-потомка: 39/39 как ожидалось — deny чтения всех секретов фикстуры и `ls ~/.ssh`, `state.json`, `ls userData`, соседнего run, `SRCREPO/src`, `SRCREPO/.git/config`; deny записи в `state.json`, корень userData, соседний run, `SRCREPO`, `node_modules`, `REALHOME`, `outside/`, `DARWIN_USER_TEMP_DIR`; deny localhost/внешнего TCP/DNS/openpty; allow чтения/записи копии, tmp, fakehome, `require` через symlink `node_modules`, `git log` в `clone --shared`. Env внутри: `HOME LANG OLDPWD PATH PWD SHLVL TMPDIR _` (+ `__CF_USER_TEXT_ENCODING` у потомков node); `HOME=<run>/home`.
- `denyhome`: `~/notes.txt` denied (без denyhome — allowed); node + lib из toolchain внутри HOME работают только с `TOOLCHAIN`; `sh`/`git` из `/usr/bin` работают без него. **Exec бинарника из запрещённого каталога разрешён** (`node -e 0` без `TOOLCHAIN`) — deny на чтение не мешает запуску.
- С реальным `$HOME` в `REALHOME` (ничего не читается, только exec): `sh`, `git --version`, `node -e 0` работают; чтение lib из `~/.hermes/node` — только с `TOOLCHAIN=<node-prefix>`.
- `localhost:PORT`: свой сервер на PORT работает, случайный порт и чужой сервис на другом порту — denied. **Не обеспечено:** чужой сервис на том же PORT доступен; bind `0.0.0.0:PORT` разрешён, и сервер в песочнице принимает подключение на LAN-IP машины.
- `unix` в `TMP`: свой сокет работает; подключение к сокету вне `TMP` и listen вне `TMP` — denied. Лимит `sun_path` 104 байта: путь `<userData>/runs/<id>/tmp/…` его превышает — работать через относительный путь (cwd=TMP), Seatbelt сравнивает разрешённый путь.
- PTY: `runner.sb` — openpty и открытие чужого pty denied. `runner-pty.sb` — openpty работает, **но открывается и чужой `/dev/ttysNNN`** того же uid (проверено на pty, созданном вне песочницы). openpty требует read+write на `/dev/ttys*` (с `(allow pseudo-tty)` + только `/dev/ptmx` — `openpty: Operation not permitted`); фильтра «свой pty» нет — сузить не удалось, **не обеспечено**.

Не проверено: Linux, securityd/реальный keychain (только файловый deny на фиктивный `login.keychain-db`), TIOCSTI на чужой tty, Apple Events, реальные тесты проекта в профиле, подключение с другой машины по LAN.

Прочее (прежние эксперименты, файлы `prec.sb`, `prec2.sb`, `detach2.cjs`):

```bash
cd "$P/sb"; D=$PWD
# поиск беглеца: env-токен (ps -axE -ww) виден только у не-платформенных бинарников своего uid (node), НЕ у Apple platform binaries (/bin/sleep, вероятно sh/git/perl); второй признак — cwd (оба обходимы):
lsof -d cwd -Fpn | awk -v pre="n$D" '/^p/{p=substr($0,2)} index($0,pre)==1{print p}'

# precedence / symlink / hardlink (home/ — фиктивный)
mkdir -p fakehome/proj fakehome/.codex; echo fakeauth > fakehome/.codex/auth.json; echo code > fakehome/proj/src.js
sandbox-exec -f prec.sb -D HOME2=$D/fakehome cat fakehome/proj/src.js        # ok (узкий allow поверх deny)
sandbox-exec -f prec.sb -D HOME2=$D/fakehome cat fakehome/.codex/auth.json   # Operation not permitted
ln -sf $D/fakehome/.codex/auth.json fakehome/proj/link; sandbox-exec -f prec.sb -D HOME2=$D/fakehome cat fakehome/proj/link   # denied
ln -f fakehome/.codex/auth.json fakehome/proj/hl; sandbox-exec -f prec.sb -D HOME2=$D/fakehome cat fakehome/proj/hl           # ЧИТАЕТСЯ (path-based)
rm -f fakehome/proj/hl fakehome/proj/link
sandbox-exec -f prec2.sb -D HOME2=$D/fakehome /bin/ln fakehome/.codex/auth.json fakehome/proj/hl2   # Operation not permitted (изнутри нельзя)
```

## 2. Git worktree vs clone --shared (`g/`)

```bash
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
cd "$P"; rm -rf g; mkdir g; cd g
git init -q -b main src && (cd src && echo a>a.txt && git add . && git commit -qm base)
B=$(git -C src rev-parse HEAD)
git -C src worktree add -q --lock --reason orch -b orch/run1 ../wt $B
cat src/.git/worktrees/wt/locked                  # orch   (только защита от prune/remove)
cat wt/.git                                       # gitdir: .../src/.git/worktrees/wt   (обычный файл)
git -C wt rev-parse --git-common-dir              # .../src/.git
C=$(git -C wt rev-parse --path-format=absolute --git-common-dir)

git -C wt update-ref refs/heads/evil HEAD; git -C src branch --list evil        # evil
echo $B > $C/refs/heads/evil2; git -C src branch --list 'evil*'                 # evil, evil2
git -C wt config alias.x '!echo pwned'; git -C src config --get alias.x          # !echo pwned
printf '#!/bin/sh\necho HOOK-RAN-IN $(pwd) >> %s/hooklog\n' $PWD > $C/hooks/post-checkout; chmod +x $C/hooks/post-checkout
(cd src && git checkout -q -b t1 && git checkout -q main); cat hooklog          # HOOK-RAN-IN .../g/src (x2, по разу на checkout)
rm $C/hooks/post-checkout; git -C src config --unset alias.x

# снимок через временный индекс; fsmonitor/reference-transaction как «ловушки»
: > hooklog
printf '#!/bin/sh\necho REFTX $1 >> %s/hooklog\n' $PWD > $C/hooks/reference-transaction; chmod +x $C/hooks/reference-transaction
git -C src config core.fsmonitor "echo FSMON >> $PWD/hooklog; false"
before="$(shasum src/.git/index; git -C src -c core.fsmonitor=false status --porcelain; git -C src rev-parse HEAD)"
echo change > wt/b.txt; T=$(mktemp -d "$P/g/idx.XXXX")
( cd wt; GIT_INDEX_FILE=$T/idx git read-tree HEAD; GIT_INDEX_FILE=$T/idx git add -A
  CM=$(git commit-tree $(GIT_INDEX_FILE=$T/idx git write-tree) -p HEAD -m cp); git update-ref refs/canvastty/run1/cp1 $CM )
cat hooklog                                       # FSMON x4, REFTX prepared, REFTX committed  <- код выполнен
: > hooklog
GIT_DIR=$C GIT_WORK_TREE=$PWD/wt GIT_INDEX_FILE=$T/idx2 git -c core.hooksPath=/dev/null -c core.fsmonitor=false read-tree HEAD
GIT_DIR=$C GIT_WORK_TREE=$PWD/wt GIT_INDEX_FILE=$T/idx2 git -c core.hooksPath=/dev/null -c core.fsmonitor=false add -A
GIT_DIR=$C git -c core.hooksPath=/dev/null update-ref refs/canvastty/run1/cp2 refs/canvastty/run1/cp1
cat hooklog                                       # пусто
after="$(shasum src/.git/index; git -C src -c core.fsmonitor=false status --porcelain; git -C src rev-parse HEAD)"
[ "$before" = "$after" ] && echo SRC UNCHANGED
git -C src config --unset core.fsmonitor; rm $C/hooks/reference-transaction

# подмена commondir
mkdir fake; cp -R $C/objects $C/refs $C/HEAD fake/
printf '[core]\n\trepositoryformatversion = 0\n\tfsmonitor = "echo FSMON-FAKE >> %s/log3; false"\n' $PWD > fake/config
cp $C/worktrees/wt/commondir cd.bak; echo "$PWD/fake" > $C/worktrees/wt/commondir; : > log3
git -C wt status >/dev/null 2>&1; cat log3; : > log3                                        # FSMON-FAKE x2 (discovery)
GIT_DIR=$C/worktrees/wt GIT_WORK_TREE=$PWD/wt git status >/dev/null 2>&1; cat log3; : > log3  # FSMON-FAKE x2
GIT_DIR=$C GIT_WORK_TREE=$PWD/wt GIT_INDEX_FILE=$T/idx3 git add -A; cat log3                 # пусто
cp cd.bak $C/worktrees/wt/commondir

# fingerprint общего gitdir
../fp.sh $C; printf '[core]\n\tfsmonitor = x\n' >> $C/config; ../fp.sh $C   # хэши различаются
git --git-dir=$C config --unset core.fsmonitor

# clone --shared: изоляция config/hooks/refs
git clone -q --shared --no-checkout src cl && git -C cl checkout -q --detach $B
cat cl/.git/objects/info/alternates               # .../src/.git/objects
git -C cl config core.fsmonitor "echo FSMON-CLONE >> $PWD/hooklog2; false"; : > hooklog2
git -C cl update-ref refs/heads/evil3 HEAD
(cd cl && echo x>c.txt && git add c.txt && git commit -qm agentwork); W=$(git -C cl rev-parse HEAD)
: > hooklog2                                      # (сам клон исполняет свой fsmonitor — это ожидаемо)
git -C src status >/dev/null; git -C src branch --list evil3; cat hooklog2   # пусто / пусто
git -C src -c core.hooksPath=/dev/null -c core.fsmonitor=false fetch -q ../cl "+${W}:refs/canvastty/run2/result"
git -C src cat-file -t $W; cat hooklog2           # commit / пусто

# обычный локальный clone делает hardlink объектов
git clone -q src cl2; stat -f '%l' $(find src/.git/objects -type f -path '*/[0-9a-f][0-9a-f]/*' | head -1)   # 2
git -C src worktree unlock ../wt
```
