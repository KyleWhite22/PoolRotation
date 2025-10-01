import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import GuardManager from "./pages/GuardManager";

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/guards" element={<GuardManager />} />
      </Routes>
    </Router>
  );
}