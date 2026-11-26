# Lesson 1: a tiny command-line app with no Dockerfile yet.
. "$DOJO_FILES/lib.sh"
mkdir -p ~/greeter
cat > ~/greeter/greet.sh <<'EOF'
#!/bin/sh
echo "Hello, ${NAME} (greeter $(cat VERSION))"
EOF
echo 1.0 > ~/greeter/VERSION
cat > ~/greeter/README.md <<'EOF'
# greeter
Prints a greeting. Reads NAME from the environment (default: world) and its version from ./VERSION.
EOF
