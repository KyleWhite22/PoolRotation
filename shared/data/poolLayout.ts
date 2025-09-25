export type Position = {
  id: string;
  label: string;
  x: number;
  y: number;
};

export type Edge = {
  from: string; 
  to: string;   
};

export const POSITIONS: Position[] = [
  { id: "1.1",     label: "1.1",     x: 190, y: 165 },
  { id: "1.2",    label: "1.2",     x: 145, y:165 },
  { id: "1.3",   label: "1.3",   x: 100, y: 165 },
  { id: "2.1",   label: "2.1",   x: 215, y: 115 },
  { id: "2.2",   label: "2.2",   x: 205, y: 50 },
  { id: "2.3",   label: "2.3",   x: 125, y: 60 },
  { id: "3.1",   label: "3.1",   x: 50, y: 210 },
  { id: "3.2",   label: "3.2",   x: 2, y: 165 },
  { id: "3.3",   label: "3.3",   x: 2, y: 105 },
  { id: "4.1",   label: "MainPoolSlide",   x: 50, y: 60 },
  { id: "4.2",   label: "MainPoolSlide.2",   x: 50, y: 90 },
];

export const EDGES: Edge[] = [
  { from: "1.1",  to: "1.2" },
  { from: "1.2",  to: "1.3" },
  { from: "2.1",  to: "2.2" },
  { from: "2.2",  to: "2.3" },
   { from: "3.1",  to: "3.2" },
  { from: "3.2",  to: "3.3" },
   { from: "4.1",  to: "4.2" },
   

];

export const VIEWBOX = { x: 0, y: 20, width: 200, height: 200 };

export const POOL_PATH_D =
  "m 27.139815,77.126139 107.639265,0.306665 4.7533,-9.9666 -0.15333,-19.779864 23.45983,0.153332 0.15334,19.626532 5.36663,12.113252 0.61332,62.559574 -90.466041,0.15333 -0.153332,34.95976 -52.286309,0.30667 z";

export const REST_STATIONS = new Set<string>(["1.2", "2.2", "3.1"]);
