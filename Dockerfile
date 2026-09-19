FROM texlive/texlive:latest

# Instalar Node.js 20 sobre la imagen de TeX Live completo
# (texlive/texlive ya trae pdflatex, xelatex, xeCJK, tex4ht, make4ht y
# tex4ebook de fábrica -- scheme-full incluye TODOS los paquetes de TeX
# Live, CJK incluido)
#
# FIX (compilación rota en idiomas CJK -- ja/zh/ko): xelatex+xeCJK ya
# estaban en la imagen, pero xeCJK necesita una FUENTE del sistema
# (vía fontconfig, \setCJKmainfont{...} busca por nombre, no por
# paquete de TeX Live) y ninguna venía instalada -- de ahí que
# pdflatex, y también xelatex sin esto, no pudieran tipografiar
# ideogramas. fonts-noto-cjk es un paquete de fuentes de Debian (no de
# TeX Live), probado en un contenedor de prueba idéntico: compiló
# "ガロア理論" sin errores usando \setCJKmainfont{Noto Sans CJK JP}
# (ver lib/idiomaCjk.js, que usa las 4 variantes JP/KR/SC/TC de este
# mismo paquete).
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    fonts-noto-cjk \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/server.js"]
