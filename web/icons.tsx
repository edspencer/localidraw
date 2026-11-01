// Tabler outline icons (MIT), the set Excalidraw's own icons come from, at its 1.25 stroke.
import type { ReactNode } from "react";

const icon = (children: ReactNode) => (
  <svg aria-hidden="true" focusable="false" role="img" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" className="ld-icon">
    {children}
  </svg>
);

export const FoldersIcon = icon(<>
  <path d="M9 4h3l2 2h5a2 2 0 0 1 2 2v7a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2" />
  <path d="M17 17v2a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2h2" />
</>);

export const CanvasIcon = icon(<>
  <path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4" />
  <path d="M13.5 6.5l4 4" />
</>);

export const PlusIcon = icon(<>
  <path d="M12 5l0 14" />
  <path d="M5 12l14 0" />
</>);

export const SearchIcon = icon(<>
  <path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" />
  <path d="M21 21l-6 -6" />
</>);

export const CloseIcon = icon(<>
  <path d="M18 6l-12 12" />
  <path d="M6 6l12 12" />
</>);
