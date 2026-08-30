import { createFileRoute } from "@tanstack/react-router";
import { GameApp } from "@/ui/GameApp";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <GameApp />;
}
