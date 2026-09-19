#!/data/data/com.termux/files/usr/bin/bash
# atalho para o Tab S10: entra na pasta, semeia se precisar e sobe o servidor
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null || { echo "instale o node: pkg install nodejs-lts"; exit 1; }
node seed.js
exec node server.js
