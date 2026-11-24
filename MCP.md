# Mini DM MCP (somente leitura)

Endpoint: `POST /api/mcp` (Streamable HTTP, JSON-RPC 2.0).

## Segurança
Configure `MCP_ACCESS_TOKEN` como **Sensitive** em Vercel > Project > Settings > Environment Variables, em Production/Preview conforme necessário. Use um token aleatório forte, separado do VERIFY_TOKEN e do token da Meta.

Todas as chamadas devem incluir `Authorization: Bearer <MCP_ACCESS_TOKEN>`. O projeto possui Deployment Protection (Vercel Authentication) habilitada; o cliente MCP também precisa obter acesso autorizado à implantação. Não desative a proteção geral do aplicativo só para conectar o MCP.

## Ferramentas
- `consultar_status`
- `listar_perfis`
- `listar_regras`
- `consultar_estatisticas`
- `consultar_historico`
- `listar_agendamentos`

Somente leitura: nenhuma ferramenta ativa envios, muda regras, remove dados, cria agendamentos ou troca tokens.

## Exemplo de conexão
```json
{
  "mcpServers": {
    "mini-dm": {
      "url": "https://mini-dm-webhook.vercel.app/api/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_ACCESS_TOKEN>"
      }
    }
  }
}
```

Para clientes que não aceitam headers estáticos, configure um proxy MCP autenticado (preferencialmente OAuth). A implementação não fornece OAuth.

## Exemplo de teste
```bash
curl -X POST "https://mini-dm-webhook.vercel.app/api/mcp" \
  -H "Authorization: Bearer $MCP_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Se a Vercel solicitar login por Deployment Protection, autentique a chamada conforme a política do projeto. A chamada só funciona depois que o endpoint for implantado e o token configurado.
