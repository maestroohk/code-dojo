# The first day

> **Byte & Biscuit Ltd** delivers warm biscuits by drone. You are its brand-new sysadmin. Your predecessor, Gary, left last Friday to start a llama farm. He did not leave documentation. He left **clues**.

Today's mission: find your way around Gary's server `shortbread`, dig up what he hid, and start some notes of your own. Press **Start lab** and you get a shell as `root` (the all-powerful admin user) on the server.

## Where am I?

Linux has **one** tree of folders, starting at `/` (the "root" directory). There are no drive letters.

```
/              the top of everything
/root          root's home directory (that's you)
/home/gary     Gary's home directory
/etc           settings files
/var/log       logs
/opt, /srv     add-on software and served data
```

The commands you need today:

```
pwd                 # print working directory: where am I?
ls                  # list what is here
ls -l               # long list: permissions, owner, size, date
ls -a               # all, including hidden files (names starting with .)
cd /var/log         # change directory (absolute path: starts with /)
cd log              # relative path: "log" inside where I am now
cd ..               # one level up
cd                  # home (same as cd ~)
```

Press **Tab** to complete names: type `cd /var/l` and press Tab. It saves typing and typos. The **Up arrow** brings back your previous command.

## Reading files

```
cat file            # dump the whole file
head -n 5 file      # first 5 lines
tail -n 5 file      # last 5 lines
less file           # scroll: arrows, PgUp/PgDn, /word searches, G = end, q = quit
wc -l file          # count lines
```

## Finding files

```
find /srv -name notes.txt       # every file called notes.txt under /srv
find /srv -name '*.bak'         # * matches anything (quote the pattern)
find /srv -type d               # only directories
```

## Making things

```
mkdir notes                     # make a directory
echo 'hello' > file.txt         # write a line to a file (replaces what was there)
echo 'more' >> file.txt         # append a line
nano file.txt                   # a friendly editor (Ctrl+O save, Ctrl+X exit)
```

> Stuck? Every task has gentle **hints** (press Hint again for a bigger one) and a solution if you really need it. Nothing here can break anything that matters: **Restart** gives you a brand-new server, with new secrets.

This mission practises module 1 of the *Linux & the shell* track (navigating and finding things).
