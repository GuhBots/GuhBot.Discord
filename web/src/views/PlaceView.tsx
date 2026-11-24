import { ViewFrame } from "./ViewFrame.js";

export function PlaceView(props: { placeId: string | null }) {
  return (
    <ViewFrame label="Place" head={<h1>Place {props.placeId}</h1>}>
      <div className="empty">Coming next.</div>
    </ViewFrame>
  );
}
