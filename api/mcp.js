/**
 * Mini DM MCP - Streamable HTTP, ferramentas somente leitura.
 * Autenticação: Authorization: Bearer <MCP_ACCESS_TOKEN>
 * Não exponha o MCP_ACCESS_TOKEN em clientes públicos.
 */
import { timingSafeEqual } from "node:crypto";
import { loadStore, listProfiles, profileContext, filterLogs } from "../lib/store.js";

const VERSION = "2025-03-26";
const allowed = {
  consultar_status: { description: "Verifica a saúde do Mini DM e seus indicadores gerais. Não envia mensagens.", schema: { type:"object", properties:{}, additionalProperties:false } },
  listar_perfis: { description: "Lista os perfis do Instagram conectados ao Mini DM.", schema: {type:"object",properties:{},additionalProperties:false} },
  listar_regras: { description: "Lista as regras de palavras-chave de um perfil do Instagram.", schema: {type:"object",properties:{profile_id:{type:"string",description:"ID retornado por listar_perfis; omita para o perfil padrão"}},additionalProperties:false} },
  consultar_estatisticas: { description: "Resumo de regras, mensagens enviadas, simuladas e erros de um perfil.", schema: {type:"object",properties:{profile_id:{type:"string"}},additionalProperties:false} },
  consultar_historico: { description: "Consulta registros de mensagens, filtrando por texto e status, sem enviar nada.", schema:{type:"object",properties:{profile_id:{type:"string"},busca:{type:"string"},status:{type:"string",enum:["enviado","simulado","erro","sem regra",""]},pagina:{type:"integer",minimum:1,maximum:10000},limite:{type:"integer",minimum:1,maximum:100}},additionalProperties:false} },
  listar_agendamentos: { description:"Lista agendamentos existentes de um perfil, sem criar ou executar envios.",schema:{type:"object",properties:{profile_id:{type:"string"}},additionalProperties:false} }
};

function reply(res,status,payload) {
  res.statusCode=status;
  res.setHeader("Content-Type","application/json; charset=utf-8");
  res.setHeader("Cache-Control","no-store");
  res.setHeader("X-Content-Type-Options","nosniff");
  return res.end(JSON.stringify(payload));
}
function rpc(res,id,result) { return reply(res,200,{jsonrpc:"2.0",id,result}); }
function error(res,id,code,message,status=200) { return reply(res,status,{jsonrpc:"2.0",id,error:{code,message}}); }
function isAuthorized(req) {
  const secret=process.env.MCP_ACCESS_TOKEN;
  const provided=(req.headers.authorization||"").replace(/^Bearer /i,"");
  if(!secret || !provided) return false;
  const a=Buffer.from(secret);
  const b=Buffer.from(provided);
  return a.length===b.length && timingSafeEqual(a,b);
}
function profileId(args) {
  const id=args?.profile_id || "default";
  if (id !== "default" && !/^profile_[a-z0-9]+$/.test(id)) throw new Error("ID de perfil inválido");
  return id;
}
async function runTool(name,args={}) {
  if(name==="listar_perfis"){
    const profiles=await listProfiles();
    return {perfis:profiles.map(p=>({id:p.id,usuario:p.settings.accountUsername,instagram_id:p.settings.igId}))};
  }
  const id=profileId(args);
  return profileContext.run(id,async()=>{
    const store=await loadStore();
    if(name==="consultar_status") return {ok:true,servico:"mini-dm",regras:store.rules.length,registros:store.log.length,simulacao:!!store.settings.dryRun,ao_vivo:!!store.settings.live};
    if(name==="listar_regras") return {regras:store.rules.map(r=>({id:r.id,nome:r.name,canal:r.channel,post_id:r.postId,palavras:r.keywords,ativa:r.active,resposta_publica:r.publicReply,mensagem_direct:r.dmText,botao:r.dmButton}))};
    if(name==="consultar_estatisticas"){
      const log=store.log||[];
      return {regras:store.rules.length,regras_ativas:store.rules.filter(r=>r.active).length,registros:log.length,enviadas:log.filter(e=>e.status==="enviado").length,simuladas:log.filter(e=>e.status==="simulado").length,erros:log.filter(e=>e.status==="erro").length,agendamentos_pendentes:(store.schedules||[]).filter(s=>s.status==="pending").length};
    }
    if(name==="consultar_historico"){
      return filterLogs(store,{query:String(args.busca||"").slice(0,200),status:args.status||"",page:args.pagina||1,pageSize:args.limite||20});
    }
    if(name==="listar_agendamentos") return {agendamentos:(store.schedules||[]).map(s=>({id:s.id,usuario:s.username,canal:s.channel,horario:s.runAt,status:s.status,regra:s.ruleName}))};
    throw new Error("Ferramenta desconhecida");
  });
}
export default async function handler(req,res) {
  res.setHeader("Access-Control-Allow-Origin","null");
  if(!isAuthorized(req)) {
    res.setHeader("WWW-Authenticate",'Bearer realm="Mini DM MCP"');
    return reply(res,401,{error:"Autenticação necessária"});
  }
  if(req.method==="GET") { res.statusCode=405;res.setHeader("Allow","POST");return res.end("Use POST JSON-RPC"); }
  if(req.method!=="POST") return reply(res,405,{error:"Método não permitido"});
  try {
    const body=typeof req.body==="object" && req.body!==null ? req.body : JSON.parse(req.body||"{}");
    const {method,params,id}=body;
    if(body.jsonrpc!=="2.0" || typeof method!=="string") return error(res,id??null,-32600,"Requisição JSON-RPC inválida",400);
    if(method==="notifications/initialized") {res.statusCode=202;return res.end();}
    if(method==="initialize") return rpc(res,id,{protocolVersion:VERSION,capabilities:{tools:{listChanged:false}},serverInfo:{name:"mini-dm",version:"1.0.0"}});
    if(method==="ping") return rpc(res,id,{});
    if(method==="tools/list") return rpc(res,id,{tools:Object.entries(allowed).map(([name,tool])=>({name,description:tool.description,inputSchema:tool.schema}))});
    if(method==="tools/call") {
      const name=params?.name;
      if(!Object.hasOwn(allowed,name)) return error(res,id,-32602,"Ferramenta inválida");
      try {
        const output=await runTool(name,params?.arguments||{});
        return rpc(res,id,{content:[{type:"text",text:JSON.stringify(output)}]});
      }catch(e){
        console.error("[mini-dm-mcp]",name,e?.message);
        return rpc(res,id,{isError:true,content:[{type:"text",text:"Não foi possível concluir a consulta."}]});
      }
    }
    return error(res,id,-32601,"Método não encontrado");
  }catch(e){return error(res,null,-32700,"JSON inválido",400);}
}
