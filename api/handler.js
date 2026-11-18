import { handleRequest } from "../server.js";

export default function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const route = url.searchParams.get("__mini_dm_route");
  if (route) {
    url.searchParams.delete("__mini_dm_route");
    url.pathname = "/api/" + route;
    req.url = url.pathname + url.search;
  }
  return handleRequest(req, res);
}
