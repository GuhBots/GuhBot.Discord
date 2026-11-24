import type { ReactNode } from "react";

/** A view's content with its tray of actions underneath, as every view in the prototype has. */
export function ViewFrame(props: {
  head?: ReactNode;
  tray?: ReactNode;
  children: ReactNode;
  label: string;
}) {
  return (
    <>
      <main className="view" aria-label={props.label}>
        {props.head ? <div className="view-head">{props.head}</div> : null}
        {props.children}
      </main>
      <div className="tray" role="toolbar" aria-label={`${props.label} actions`}>
        {props.tray}
      </div>
    </>
  );
}
