import type { ApprovalDecision, ApprovalRequest, IHarness } from "@racso/core";
import { input, select } from "@/terminal/stdin";

// Interactive flows layered on top of the non-interactive harness primitives.
// Each flow owns the prompting; core only receives the resolved choice.

export interface Flows {
  changeProvider(harness: IHarness, name?: string): Promise<boolean>;
  changeModel(harness: IHarness, model?: string): Promise<boolean>;
  changeAgent(harness: IHarness, name?: string): Promise<boolean>;
  changeSession(harness: IHarness, target?: string): Promise<boolean>;
  promptApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
}

const pick = (
  message: string,
  options: string[],
): Promise<string | undefined> =>
  options.length ? select(message, options) : Promise.resolve(undefined);

export const createFlows = (): Flows => ({
  async changeProvider(harness, name) {
    const selected =
      name ?? (await pick("Select the provider:", harness.listProviders()));
    if (!selected) return false;
    return harness.setProvider(selected);
  },

  async changeModel(harness, model) {
    const selected =
      model ?? (await pick("Select the model:", harness.listModels().map((m) => m.id)));
    if (!selected) return false;
    return harness.setModel(selected);
  },

  async changeAgent(harness, name) {
    const selected =
      name ?? (await pick("Select the agent:", harness.listAgents().map((a) => a.id)));
    if (!selected) return false;
    return harness.setAgent(selected);
  },

  async changeSession(harness, target) {
    const sessions = harness.listSessions();
    if (!sessions.length) return false;

    const resolved =
      target ??
      (await pick(
        "Select the session:",
        sessions.map((session, index) => {
          const title = session.title ? ` — ${session.title}` : "";
          return `${index + 1}) ${session.id}${title}`;
        }),
      ));

    if (!resolved) return false;

    // Menu labels are "N) id"; resolve them back to an index target.
    const labeled = /^(\d+)\)/.exec(resolved);
    const selector = labeled ? labeled[1] : resolved;

    return harness.loadSession(selector);
  },

  async promptApproval(request) {
    const answer = (
      await input(
        `Allow ${request.tool} [${request.kind}] ${request.subject}? ` +
          `[y/N/a=always] `,
      )
    ).trim();

    if (/^a(lways)?$/i.test(answer)) return "always";
    return /^y(es)?$/i.test(answer) ? "allow" : "deny";
  },
});
