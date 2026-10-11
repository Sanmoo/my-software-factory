// Operator commands of one instance (R09). The CLI only writes them to the instance's
// local queue; the instance applies them, in queue order, on its next poll.
export type CommandBody =
  | { type: "reply"; job: string; message: string }
  | { type: "resume"; job: string }
  | { type: "release"; job: string }
  | { type: "pause" }
  | { type: "unpause" };

export type OperatorCommand = CommandBody & { id: string };

export interface CommandQueue {
  // Returns the id of the queued command.
  enqueue(command: CommandBody): Promise<string>;
  // Oldest first. Files that cannot be read are listed by name, never silently dropped.
  pending(): Promise<{ commands: OperatorCommand[]; unreadable: string[] }>;
  // Removes a command once it has been applied.
  done(id: string): Promise<void>;
}
