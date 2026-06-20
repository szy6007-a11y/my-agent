import { ChatWorkspace } from "@/components/chat-workspace";

type PageProps = {
  params: Promise<{ sessionId: string }>;
};

export default async function ChatSessionPage({ params }: PageProps) {
  const { sessionId } = await params;

  return <ChatWorkspace initialSessionId={sessionId} />;
}
