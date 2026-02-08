import { Routes, Route } from 'react-router-dom';
import Landing from './pages/Landing';
import Console from './pages/Console';

function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/app" element={<Console />} />
    </Routes>
  );
}

export default App;
