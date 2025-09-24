// All units are relative to the viewBox (0..100)
export type Position = {
  id: string;
  label: string;
  x: number;
  y: number;
};

export type Edge = {
  from: string; // position id
  to: string;   // position id
};

export const POSITIONS: Position[] = [
  { id: "first",     label: "1",     x: 190, y: 165 },
  { id: "second",    label: "2",     x: 145, y:165 },
  { id: "third",   label: "3",   x: 100, y: 165 },
  
];

export const EDGES: Edge[] = [
  { from: "first",  to: "second" },
  { from: "second",  to: "third" },

];

export const VIEWBOX = { x: 0, y: 20, width: 200, height: 200 };

// A very simple “pool outline” placeholder path (rounded rectangle-like).
// Swap this with your actual outline later (export an SVG path from Figma/Illustrator).
export const POOL_PATH_D =
  "m 27.139815,77.126139 107.639265,0.306665 4.7533,-9.9666 -0.15333,-19.779864 23.45983,0.153332 0.15334,19.626532 5.36663,12.113252 0.61332,62.559574 -90.466041,0.15333 -0.153332,34.95976 -52.286309,0.30667 z";
