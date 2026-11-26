# Lesson 2: pairs of Debian version strings, picked to hit every rule of the comparison (epoch, ~, revision, digits).
set -e -o pipefail
cat > ~/versions.txt <<'EOF'
1.2.10 1.2.9
1.2~rc1 1.2
2:1.0 3.5
1.0-1 1.0-1ubuntu0.1
2.41-12 2.41-12+deb13u1
1.0+dfsg-2 1.0-3
7.88.1-10+deb12u5 8.14.1-2
0.9 0.10
1.0a 1.0
1:2.0~beta2 1:2.0~beta10
EOF
