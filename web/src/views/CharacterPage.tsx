import { ViewFrame } from "./ViewFrame.js";

export function CharacterPage(props: { id: string }) {
  return (
    <ViewFrame label="Character" head={<h1>Character {props.id}</h1>}>
      <div className="empty">Coming next.</div>
    </ViewFrame>
  );
}
