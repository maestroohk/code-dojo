# Lesson 1: two images and an empty project folder. The learner writes the compose.yaml.
. "$DOJO_FILES/lib.sh"
. "$DOJO_FILES/images.sh"
mkdir -p ~/shop
cat > ~/shop/README.md <<'EOF'
# shop
- web: image shop/web:1.0, listens on 80, should be reachable on this machine at port 8080
- cache: image busybox:1.37, command: httpd -f -p 6379 (a stand-in for Redis), not published
EOF
