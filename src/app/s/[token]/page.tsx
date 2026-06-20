import { SharedSessionView } from "@/components/shared-session-view";

type PageProps = {
  params: Promise<{ token: string }>;
};

export default async function SharedSessionPage({ params }: PageProps) {
  const { token } = await params;

  return <SharedSessionView token={token} />;
}
