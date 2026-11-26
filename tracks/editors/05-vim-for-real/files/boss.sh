# Boss: a root-owned config, a host list for a macro, and a Python indent mystery.
. "$DOJO_FILES/lib.sh"
mkdir -p /etc/app
printf '%s\n' '[server]' 'port = 8080' 'log_level = debug' 'workers = 4' > /etc/app/app.conf
chown root:root /etc/app/app.conf && chmod 644 /etc/app/app.conf
printf '%s\n' '[server]' 'port = 8080' 'log_level = info' 'workers = 4' > /opt/dojo/state/app.conf.expected

cat > ~/inventory.txt <<'EOF'
# web tier
web1.example.com
web2.example.com
# workers
jobs1.example.com
EOF
cat > /opt/dojo/state/inventory.expected <<'EOF'
# web tier
  - host: web1.example.com
    port: 443
  - host: web2.example.com
    port: 443
# workers
  - host: jobs1.example.com
    port: 443
EOF

printf '%s\n' 'set nocompatible' 'filetype plugin indent on' 'set expandtab shiftwidth=4 tabstop=4' > ~/.vimrc
mkdir -p ~/.vim/after/ftplugin ~/work
printf '%s\n' '" from an old plugin bundle' 'setlocal shiftwidth=8 noexpandtab' > ~/.vim/after/ftplugin/python.vim
cp "$DOJO_FILES/sample.py" ~/work/
mkdir -p ~/answers
chmod 644 /opt/dojo/state/*
