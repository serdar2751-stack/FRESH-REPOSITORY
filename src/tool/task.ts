import { oneLine, truncateEnd } from "../util/text.ts";
import { type Tool, ToolError } from "./types.ts";

interface TaskInput {
  description: string;
  prompt: string;
  subagent_type: string;
}

export function createTaskTool(subagents: Array<{ name: string; description: string }>): Tool<TaskInput> {
  const list = subagents.map((a) => `- ${a.name}: ${a.description}`).join("\n");
  return {
    name: "task",
    description: [
      "Launch a sub-agent that works on a task in its own context and returns a report. Available sub-agents:",
      list,
      "",
      "When to delegate:",
      "- Large, independent pieces of work that can run in parallel, such as a wide investigation across many files or modules.",
      "- Searches whose intermediate results you don't need in your own context.",
      "When not to delegate:",
      "- Work you can finish in a few tool calls yourself (reading a few files, a handful of edits, a simple search).",
      "- Reviewing or double-checking your own work; verification belongs in your own loop.",
      "How:",
      "- Brief the sub-agent completely in the prompt: it starts with no knowledge of this conversation. State the goal, relevant paths, constraints, and exactly what the report should contain.",
      "- Launch independent sub-agents in one response (several task calls) so they run concurrently. Keep the number small.",
      "- The report is not shown to the user; summarize what matters yourself. Trust the report and don't redo the sub-agent's work.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "Short (3-5 words) label for the task" },
        prompt: { type: "string", description: "Complete, self-contained instructions for the sub-agent" },
        subagent_type: { type: "string", enum: subagents.map((a) => a.name), description: "Which sub-agent to use" },
      },
      required: ["description", "prompt", "subagent_type"],
      additionalProperties: false,
    },
    readOnly: true,
    title: (input) => `${input.subagent_type ?? "agent"}: ${truncateEnd(oneLine(input.description ?? ""), 80)}`,
    async execute(input, ctx) {
      if (!ctx.runSubagent) throw new ToolError("Sub-agents are not available here (sub-agents cannot start other sub-agents).");
      if (!subagents.some((a) => a.name === input.subagent_type)) {
        throw new ToolError(`Unknown sub-agent "${input.subagent_type}". Use one of: ${subagents.map((a) => a.name).join(", ")}`);
      }
      await ctx.permit({
        permission: "task",
        patterns: [input.subagent_type],
        always: [input.subagent_type],
        title: `Start ${input.subagent_type} sub-agent: ${input.description}`,
      });
      const res = await ctx.runSubagent({ agent: input.subagent_type, description: input.description, prompt: input.prompt });
      return {
        output: res.output || "(the sub-agent returned no report)",
        title: `${input.subagent_type}: ${truncateEnd(oneLine(input.description), 80)}`,
        metadata: { sessionId: res.sessionId, agent: input.subagent_type },
      };
    },
  };
}
