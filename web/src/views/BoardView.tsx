import { ViewFrame } from "./ViewFrame.js";

export function BoardView() {
  return (
    <ViewFrame label="Board" head={<h1>Board</h1>}>
      <div className="empty">Coming next.</div>
    </ViewFrame>
  );
}
