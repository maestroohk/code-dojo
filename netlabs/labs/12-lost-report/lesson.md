# The lost report

> 08:57. The CEO bursts in. "The board meeting is at **nine thirty**. My quarterly *Biscuit Index* report is on the shared drive. Somewhere. I called it... something. FIND IT."
>
> The shared drive `/srv/shared` on server `custard` has about 300 files, a dozen folders and zero naming conventions.

Clicking through folders would take all morning. Linux gives you two power tools instead: `find` searches by **name, size and age**, and `grep` searches **inside** files.

## Wildcards

The shell understands patterns in file names:

```
*        any characters (also none)     *.csv     report*     *2025*
?        exactly one character          file-?.txt
[abc]    one of these characters        chapter-[1-3].txt
```

```
ls /srv/shared/finance/*/*.ods      # .ods files one level inside finance
```

When you give a pattern to `find`, put it in **quotes** (`'*.csv'`), so that `find` gets the pattern itself rather than the shell expanding it first.

## find

`find <where> <tests...>` walks the whole tree under `<where>`:

```
find /srv/shared -name '*.csv'          # by name (case-sensitive; -iname ignores case)
find /srv/shared -type f                # only files (-type d: only directories)
find /srv/shared -size +5M              # bigger than 5 MB (-size -10k: smaller than 10 kB)
find /srv/shared -mtime -2              # modified less than 2 days ago (+30: more than 30)
find /srv/shared -name '*.log' -type f -size +1k     # tests combine (AND)
```

Doing something with every match:

```
find /srv/shared -name '*.bak' -exec ls -l {} \;    # {} = the file, \; ends the command
find /srv/shared -name '*.bak' -delete              # careful: no undo
```

## grep

```
grep 'jam' file.txt                 # lines containing jam
grep -i 'jam' file.txt              # ignore case
grep -r 'jam' /srv/shared           # recursive: every file in the tree
grep -rl 'jam' /srv/shared          # just the file names
grep -rn 'jam' /srv/shared          # with line numbers
```

## The pipe

`|` sends the output of one command into the next. It is the single most useful character on Linux (and the subject of the next mission):

```
find /srv/shared -name '*.md' | wc -l       # how many .md files?
```

> Rule of thumb before deleting anything: run the same `find` **without** `-delete` first and read what it would hit.

This mission practises module 1 (finding things) and module 2 (files and text) of the *Linux & the shell* track.
