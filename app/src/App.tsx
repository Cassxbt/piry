import { Shell } from "./components/Shell";
import { ViewerProvider } from "./hooks/viewer";
import { Calculator } from "./sections/Calculator";
import { Evidence } from "./sections/Evidence";
import { Hero } from "./sections/Hero";
import { Position } from "./sections/Position";
import { Redeem } from "./sections/Redeem";
import { Trade } from "./sections/Trade";

export function App() {
  return (
    <ViewerProvider>
      <Shell>
        <Hero />
        <Calculator />
        <Trade />
        <Position />
        <Evidence />
        <Redeem />
      </Shell>
    </ViewerProvider>
  );
}
