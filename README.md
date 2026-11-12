# Mini DM

Software pequeno e enxuto para transformar comentário em conversa no direct do Instagram.

Quando alguém comenta uma palavra-chave no seu post, o Mini DM:

1. encontra o comentário (lendo os posts recentes, sem precisar de servidor público nem webhook);
2. responde no próprio comentário (opcional);
3. chama a pessoa no direct com a mensagem da regra.

Tudo roda na sua máquina, sem banco de dados, sem build e sem dependências: só Node.js.

## Como abrir

```bash
cd mini-dm
npm start
```

Depois abra **http://localhost:3777**.

## O que tem na tela

- **Regras** — palavra-chave, resposta pública e mensagem do direct. Use `{{username}}` para o nome de quem comentou e `{{keyword}}` para a palavra que bateu.
- **Testar agora** — simula um comentário e mostra exatamente o que sairia, sem enviar nada.
- **Histórico** — testes e envios, com status.
- **Configurações** — conta, intervalo de leitura, posts por rodada, resposta pública e modo simulação.

O modo **simulação** vem ligado: nada é enviado de verdade até você desligar.

## Credenciais

O Mini DM reaproveita as contas do setup de publicação em `C:\Users\Leona\claude-instagram\accounts.json`.
Para usar outra conta, troque o usuário em **Configurações** ou aponte `accountFile` para outro arquivo.
Também aceita `INSTAGRAM_ACCESS_TOKEN` e `INSTAGRAM_BUSINESS_ID` em um `.env` na pasta do projeto.

## O que a Meta exige para o modo ao vivo

- Conta profissional do Instagram vinculada a uma Página do Facebook.
- Token com `instagram_basic`, `pages_show_list`, `pages_read_engagement` e **`instagram_manage_messages`** (e `instagram_manage_comments` se for responder no comentário).
- App da Meta com acesso avançado a essas permissões e em modo ao vivo.
- A DM de resposta privada só é permitida até 7 dias depois do comentário e uma vez por comentário.

Os tokens atuais do setup de publicação **expiraram em 08/11/2026** e não têm permissão de mensagens.
Sem isso, o Mini DM funciona em simulação e no teste; o modo ao vivo fica bloqueado.

## Estrutura

```
mini-dm/
  server.js        API local + servidor da interface
  lib/meta.js      chamadas à Graph API
  lib/engine.js    casamento de palavras-chave e variáveis
  lib/store.js     persistência em data/store.json
  public/          interface (HTML, CSS e JS puros)
```
