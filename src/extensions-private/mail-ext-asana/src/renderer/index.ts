/**
 * Asana Extension - Renderer entry point
 * Exports panel registrations for the extension UI system.
 */
import { AsanaTaskPanel } from "./AsanaTaskPanel";

export const panelRegistrations = [
  {
    extensionId: "asana",
    panelId: "task-suggestions",
    component: AsanaTaskPanel,
  },
];
