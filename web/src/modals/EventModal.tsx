import { useWindows } from "../Shell.js";
import { Modal } from "../ui.js";

export function EventModal(props: { id: string }) {
  const windows = useWindows();
  return (
    <Modal title={`Event ${props.id.slice(0, 8)}`} onClose={windows.close}>
      <div className="content">Coming next.</div>
    </Modal>
  );
}
