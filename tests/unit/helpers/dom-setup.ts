/**
 * Side-effect module: registers happy-dom globals (DOMParser, Node, etc.)
 * so unit tests for renderer modules can run in Node.
 *
 * Import this before any module under test that touches the DOM.
 */
import { Window } from "happy-dom";

const happyWindow = new Window();
const g = globalThis as unknown as Record<string, unknown>;
g.window = happyWindow;
g.document = happyWindow.document;
g.DOMParser = happyWindow.DOMParser;
g.Node = happyWindow.Node;
g.NodeFilter = happyWindow.NodeFilter;
g.Element = happyWindow.Element;
g.HTMLElement = happyWindow.HTMLElement;
g.Document = happyWindow.Document;
g.Text = happyWindow.Text;
