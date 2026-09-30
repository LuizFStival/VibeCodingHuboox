#!/usr/bin/env python3
"""Gera elementor-widget.html a partir de index.html.

O arquivo gerado é para colar num widget "HTML" do Elementor:
- sem <html>/<head>/<body> (o WordPress já monta o <head>; título, descrição,
  favicon e og:image são configurados no plugin de SEO / Identidade do site);
- todo o CSS fica restrito ao contêiner #huboox-lp, para que o tema e os
  estilos globais do Elementor não sobrescrevam a landing.

Uso: python3 build-elementor.py
"""
import re
from pathlib import Path

HERE = Path(__file__).parent
SCOPE = "#huboox-lp"

src = (HERE / "index.html").read_text(encoding="utf-8")


def scope_selector(sel):
    sel = sel.strip()
    if sel in (":root", "body"):
        return SCOPE
    if sel == "html":
        return "html"
    if sel.startswith(".no-js"):
        return SCOPE + sel  # a classe .no-js fica no próprio contêiner
    return f"{SCOPE} {sel}"


def scope_css(css):
    out, i, stack = [], 0, []
    while i < len(css):
        brace = css.find("{", i)
        close = css.find("}", i)
        if brace == -1 or (close != -1 and close < brace):
            if close == -1:
                out.append(css[i:])
                break
            out.append(css[i:close + 1])
            if stack:
                stack.pop()
            i = close + 1
            continue
        head = css[i:brace]
        # mantém comentários antes do seletor no lugar original
        k = head.rfind("*/")
        comments, sel = (head[:k + 2], head[k + 2:]) if k != -1 else ("", head)
        lead = re.match(r"\s*", sel).group(0)
        sel_s = sel.strip()
        in_keyframes = bool(stack) and stack[-1].startswith("@keyframes")
        if sel_s.startswith("@") or in_keyframes:
            new = sel_s
        else:
            new = ", ".join(scope_selector(s) for s in sel_s.split(","))
        out.append(comments + lead + new + " {")
        stack.append(sel_s)
        i = brace + 1
    return "".join(out)


head = src[src.index("<head>"):src.index("</head>")]
body = src[src.index("<body"):src.index("</body>")]
body = body[body.index(">") + 1:]

css = re.search(r"<style>(.*?)</style>", head, re.S).group(1)
fonts = re.search(r'<link rel="preload" as="style" href="([^"]+)"', head).group(1)
jsonld = re.search(r'(<script type="application/ld\+json">.*?</script>)', head, re.S).group(1)

css = scope_css(css)
css += f"""
  /* Ajustes para rodar dentro do Elementor */
  {SCOPE} {{ position: relative; overflow-x: clip; }}
  {SCOPE} button, {SCOPE} button:hover, {SCOPE} button:focus {{ text-transform: none; letter-spacing: normal; }}
"""

# o script usa document.body para a classe no-js; troca pelo contêiner
body = body.replace('document.body.classList.remove("no-js");',
                    'document.getElementById("huboox-lp").classList.remove("no-js");')

out = f"""<!-- Huboox landing — versão para widget HTML do Elementor.
     Gerado por build-elementor.py a partir de index.html. Não edite à mão:
     altere index.html e rode o script de novo. -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="{fonts}">
{jsonld}
<style>{css}</style>
<div id="huboox-lp" class="no-js">
{body.strip()}
</div>
"""
(HERE / "elementor-widget.html").write_text(out, encoding="utf-8")
print("elementor-widget.html gerado:", len(out), "bytes")
