import { useWindows } from "../Shell.js";
import { Modal } from "../ui.js";

export function CalendarModal() {
  const windows = useWindows();
  return (
    <Modal title="Go to a year or date" onClose={windows.close}>
      <div className="content">Coming next.</div>
    </Modal>
  );
}
