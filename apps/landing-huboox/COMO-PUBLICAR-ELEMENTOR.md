# Publicar a landing no WordPress + Elementor (huboox.com)

No WordPress, o `<head>` da página é montado pelo próprio WordPress. Por isso, tudo o que
estava no `<head>` do `index.html` (título, descrição, favicon, imagem de compartilhamento)
**é ignorado** quando o HTML é colado no Elementor. Esses itens são configurados nos passos abaixo.

## 1. Trocar o código do widget

1. Abra a página no Elementor.
2. No widget **HTML**, apague o código atual e cole **todo** o conteúdo de `elementor-widget.html`.
   - Essa versão tem o estilo isolado (`#huboox-lp`), então o tema e as fontes globais do Elementor não interferem.
3. Deixe o contêiner do widget em **largura total**, com padding e margens em **0**.
4. Em **Configurações da página (⚙) → Layout da página**, escolha **Elementor Canvas**.
   Isso remove o cabeçalho e o rodapé do tema (a landing já tem os dela).
5. **Configurações → Leitura**: defina esta página como **Página inicial**.

> Se editar a landing depois: altere `index.html` e rode `python3 build-elementor.py` para gerar um novo `elementor-widget.html`.

## 2. Ícone do site (favicon)

**Aparência → Personalizar → Identidade do site → Ícone do site** → envie `site-icon-512.png`.
O WordPress gera sozinho o favicon e o ícone para iPhone/Android.

## 3. SEO da página (Rank Math, Yoast ou All in One SEO)

Se ainda não tiver plugin de SEO, instale **Rank Math** ou **Yoast** (ambos gratuitos). Na página, preencha:

| Campo | Valor |
|---|---|
| Título SEO | `Criação de Sites em Curitiba \| Huboox — Soluções Digitais` |
| Meta descrição | `Criação de sites, landing pages, Google Meu Negócio e sistemas sob medida em Curitiba. Soluções digitais que resolvem a dor do seu negócio. Fale no WhatsApp.` |
| Palavra-chave foco | `criação de sites Curitiba` |
| URL canônica | `https://huboox.com/` (o plugin preenche sozinho) |
| Imagem de redes sociais (Facebook/WhatsApp e X) | envie `og-image.png` |
| Título para redes sociais | `Huboox — Soluções digitais que resolvem a dor do seu negócio` |

No plugin, em **Local SEO / Organização**, use exatamente os mesmos dados do site:
**Huboox · Curitiba/PR · (41) 99640-8701 · instagram.com/huboox.digital**.

> Os dados estruturados da Huboox (JSON-LD) já estão dentro do `elementor-widget.html`. Pode manter junto com os do plugin.

## 4. Configurações que decidem se o Google indexa

- **Configurações → Leitura**: **desmarque** “Evitar que mecanismos de busca indexem este site”.
- **Configurações → Geral**: “Endereço do WordPress” e “Endereço do site” com **https://huboox.com**
  (não `http://`). Confirme com a hospedagem que `http://` redireciona para `https://`.
- **Configurações → Links permanentes**: “Nome do post”.
- **Não** envie `robots.txt` nem `sitemap.xml` desta pasta: o WordPress e o plugin de SEO já geram os dois
  (`/sitemap_index.xml` no Rank Math/Yoast, ou `/wp-sitemap.xml` sem plugin). O arquivo `_headers` também não se aplica.

## 5. Google Search Console

1. Acesse https://search.google.com/search-console e adicione **huboox.com** (verificação por DNS ou pelo plugin de SEO).
2. Em **Sitemaps**, envie o endereço do sitemap do plugin (ex.: `sitemap_index.xml`).
3. Em **Inspeção de URL**, cole `https://huboox.com/` e clique em **Solicitar indexação**.

## 6. Velocidade no WordPress

A landing sozinha fez 100 no Lighthouse. Dentro do WordPress, quem pesa é o próprio WordPress:

- **Plugin de cache**: LiteSpeed Cache (se a hospedagem for LiteSpeed/Hostinger) ou WP Super Cache.
- **Elementor → Configurações → Avançado**: “Carregar Google Fonts” → **Desativar** (a landing já carrega Sora e Inter).
- **Elementor → Configurações → Recursos**: ative “Carregamento de recursos aprimorado”, “Saída de DOM otimizada”
  e “Ícones de fonte inline”.
- Desative plugins que não são usados nesta página.
- Meça em https://pagespeed.web.dev com `https://huboox.com/` (aba **Celular**). Meta: acima de 90.

## Checklist rápido

- [ ] Widget HTML atualizado com `elementor-widget.html`
- [ ] Layout **Elementor Canvas**, largura total, sem padding
- [ ] Página definida como inicial
- [ ] Ícone do site = `site-icon-512.png`
- [ ] Título, descrição e imagem social no plugin de SEO
- [ ] “Evitar indexação” desmarcado e endereço com **https**
- [ ] Site e sitemap enviados no Search Console
- [ ] Cache ativo e Google Fonts do Elementor desativado
- [ ] Perfil no Google Meu Negócio com o mesmo nome, cidade e telefone
