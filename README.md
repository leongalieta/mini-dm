# Mini DM

Software pequeno e enxuto para transformar comentário em conversa no direct do Instagram.

Quando alguém comenta uma palavra-chave no seu post, o Mini DM:

1. encontra o comentário (lendo os posts recentes, sem precisar de servidor público nem webhook);
2. responde no próprio comentário (opcional);
3. chama a pessoa no direct com a mensagem da regra.

Tudo roda na sua máquina com Node.js.

## Como abrir

### Local
```bash
cd mini-dm
npm start
```
Depois abra **http://localhost:3777**.

### Com Docker
```bash
docker build -t mini-dm .
docker run -p 3777:3777 --env-file .env mini-dm
```

Copie `.env.example` para `.env` e preencha os valores antes de rodar.

## O que tem na tela

- **Regras** — palavra-chave, resposta pública e mensagem do direct. Use `{{username}}` e `{{keyword}}`.
- **Testar agora** — simula um comentário e mostra exatamente o que sairia.
- **Histórico** — testes e envios, com status, filtro e paginação.
- **Agendamentos** — mensagens programadas para enviar no futuro (criar, editar, cancelar).
- **Estatísticas** — resumo, por regra e por dia. Exportar CSV.
- **Agente de IA** — Gemini ou OpenAI para respostas automáticas (temperatura, modelo, prompt).
- **Configurações** — conta, intervalo de leitura, modo simulação, modo ao vivo, token do Instagram.

O modo **simulação** vem ligado: nada é enviado de verdade até você desligar.

## API

- `GET /api/health` — health check
- `GET /api/state` — estado do app
- `POST /api/check` — validar conexão com a Meta
- `POST /api/rules` — criar/editar regra
- `DELETE /api/rules/:id` — excluir regra
- `GET /api/log/filter` — logs filtrados e paginados
- `GET /api/log/export` — exportar logs CSV
- `GET /api/stats` — estatísticas
- `GET /api/stats/export` — exportar estatísticas CSV
- `GET/POST /api/schedules` — agendamentos
- `PUT/DELETE /api/schedules/:id` — editar/excluir agendamento
- `POST /api/schedules/:id/cancel` — cancelar agendamento
- `GET/POST /api/ai/config` — configuração do agente de IA
- `POST /api/ai/test` — testar agente de IA

## Rate limiting

60 requisições por minuto por IP (exceto webhook da Meta).

## Testes

```bash
npm test
```

## Credenciais

O Mini DM reaproveita as contas do setup de publicação em `C:\Users\Leona\claude-instagram\accounts.json`.
Para usar outra conta, troque o usuário em **Configurações** ou aponte `accountFile` para outro arquivo.
Também aceita `INSTAGRAM_ACCESS_TOKEN` e `INSTAGRAM_BUSINESS_ID` em um `.env` na pasta do projeto.

## O que a Meta exige para o modo ao vivo

- Conta profissional do Instagram vinculada a uma Página do Facebook.
- Token com `instagram_basic`, `pages_show_list`, `pages_read_engagement` e **`instagram_manage_messages`** (e `instagram_manage_comments` se for responder no comentário).
- App da Meta com acesso avançado a essas permissões e em modo ao vivo.
- A DM de resposta privada só é permitida até 7 dias depois do comentário e uma vez por comentário.

## Estrutura

```
mini-dm/
  server.js        API local + servidor da interface
  lib/meta.js      chamadas à Graph API
  lib/engine.js    casamento de palavras-chave e variáveis
  lib/store.js     persistência em data/store.json
  lib/ai.js        agente de IA (Gemini/OpenAI)
  public/          interface (HTML, CSS e JS puros)
  tests/           testes automatizados
  Dockerfile       build de container
  .env.example   variáveis de ambiente de exemplo
```

## O que ainda falta (produção)

- Banco de dados real (atualmente usa JSON em `data/store.json`)
- Autenticação de usuário (atualmente senha única opcional)
- Webhook real da Meta configurado na Shard Cloud
- Criptografia de chaves de API em repouso

