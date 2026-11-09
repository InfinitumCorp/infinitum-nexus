import { conjureClient } from "./engine.ts";
export function fakeEngine(
  intercept?: (
    path: string,
    init: RequestInit,
  ) => Response | Promise<Response> | undefined,
) {
  const calls: { path: string; init: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, init });
    const replacement = intercept?.(path, init);
    if (replacement) return replacement;
    const ok = (data: unknown) => Response.json({ success: true, data });
    switch (path) {
      case "/api/graph/ontology/generate":
        return ok({ project_id: "project_1" });
      case "/api/graph/build":
        return ok({ task_id: "graph_task" });
      case "/api/graph/task/graph_task":
        return ok({ status: "completed", result: { graph_id: "graph_1" } });
      case "/api/simulation/create":
        return ok({ simulation_id: "simulation_1" });
      case "/api/simulation/prepare":
        return ok({ task_id: "prepare_task" });
      case "/api/simulation/prepare/status":
        return ok({ status: "completed" });
      case "/api/simulation/start":
        return ok({});
      case "/api/simulation/simulation_1/run-status":
        return ok({
          runner_status: "completed",
          current_round: 5,
          total_actions_count: 20,
        });
      case "/api/report/generate":
        return ok({ report_id: "report_1", task_id: "report_task" });
      case "/api/report/generate/status":
        return ok({ status: "completed" });
      case "/api/report/report_1":
        return ok({
          markdown_content:
            "# Qualitative scenario rehearsal\nAssumptions require operator review; not a calibrated probability.",
        });
      case "/api/simulation/stop":
        return ok({});
      default:
        return new Response("not-found", { status: 404 });
    }
  };
  return {
    calls,
    fetchImpl,
    client: conjureClient({ baseUrl: "https://engine.example", fetchImpl }),
  };
}
