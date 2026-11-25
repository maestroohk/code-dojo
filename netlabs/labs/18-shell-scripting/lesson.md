# Shell scripting 101

> The new oven controller on `richtea` calls little helper scripts, and before any script goes live, the **Robot Tester 9000** runs it with dozens of inputs. It is strict, it is fast and it has no sense of humour. Every task below is checked by the robot: write the script, press **Check**, read its complaint, fix, repeat.

Some sample data to play with: `/srv/batches`, `/srv/recipes` and `/root/orders.txt`.

## Anatomy of a script

```
#!/bin/bash
# greet.sh - says hello
name="$1"
echo "Hello, $name!"
```

```
nano /root/greet.sh        # write it (Ctrl+O save, Ctrl+X exit)
chmod +x /root/greet.sh    # make it executable (once)
/root/greet.sh Ada         # run it (or ./greet.sh from inside /root)
```

The first line, `#!/bin/bash` (the *shebang*), says which program runs the file.

## Variables and quoting

```
name="Ada"                  # no spaces around =
echo "Hi $name"             # double quotes: variables are expanded
echo 'Hi $name'             # single quotes: literally $name
$1 $2 ...                   # arguments          $#   how many arguments
"${1:-default}"             # $1, or "default" if it is empty
today=$(date +%F)           # the output of a command
n=$((n + 1))                # arithmetic
```

**Always quote variables**: `"$file"`. Unquoted, a file called `oat raisin.batch` becomes two words.

## Decisions and exit codes

Every command ends with an **exit code**: 0 means success, anything else is a failure. `$?` holds the last one. `exit 3` ends your script with code 3.

```
if [ "$n" -lt 10 ]; then        # -lt -le -gt -ge -eq -ne compare numbers
  echo "small"
elif [ "$n" -eq 10 ]; then
  echo "ten"
else
  echo "big"
fi
[ -d "$dir" ]   [ -f "$file" ]   [ -z "$s" ]   [ "$a" = "$b" ]   [ ! ... ]
```

The spaces inside `[ ... ]` are not optional: `[` is a command and its parts are arguments.

## Loops

```
for f in /srv/batches/*.batch; do       # over files (sorted)
  echo "found $f"
done

for i in 1 2 3; do echo "$i"; done      # over a list

while read -r item qty; do              # over lines of stdin
  echo "$item: $qty"
done < /root/orders.txt
```

## Talking to the user

```
echo "result"                # stdout: the script's answer
echo "error: no such dir" >&2   # stderr: complaints, so they don't pollute the answer
```

> Debugging: run `bash -x ./script.sh args` to see every line as it runs. Real scripts often start with `set -euo pipefail` to stop at the first error (module 5 of the track explains it).

This mission practises module 5 of the *Linux & the shell* track (variables, quoting, exit codes, control flow).
