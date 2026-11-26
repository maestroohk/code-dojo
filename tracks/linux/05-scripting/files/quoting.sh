# Lesson 1: a deploy script with the quoting and default-value bugs every team ships once.
set -e -o pipefail
mkdir -p ~/deploy ~/build
echo 'console.log("shop")' > ~/build/app.js
echo 'Fixed the checkout button.' > ~/build/"release notes.txt"
cat > ~/deploy/deploy.sh <<'EOF'
#!/bin/bash
# Usage: deploy.sh FILE [ENV]     copies FILE into ~/sites/ENV/ (ENV defaults to staging)
file=$1
env=$2
target=$HOME/sites/$env
mkdir -p $target
cp $file $target/
echo "deployed $file to $env"
EOF
chmod 755 ~/deploy/deploy.sh
