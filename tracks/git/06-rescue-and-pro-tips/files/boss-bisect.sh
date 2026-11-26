# Boss: a long history since v3.1.0 with one bad commit (bisect).
COMMITS=120 BAD_AT=83 GOOD_TAG=v3.1.0 . "$DOJO_FILES/bisect.sh"
cd ~/shop && git tag -a v3.2.0 -m "Release 3.2.0"