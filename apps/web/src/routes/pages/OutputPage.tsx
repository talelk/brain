import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { useParams } from "@solidjs/router";
import ArtifactDetailPage from "./ArtifactDetailPage";
import NamedOutputPage from "./NamedOutputPage";

/**
 * `/outputs/:id` and `/outputs/:id/compare` (T61, #43). A named mission output
 * (`output-…`) shows its versions and lineage; material produced outside any
 * mission is addressed by its artifact id and shows that artifact's history.
 */
export default function OutputPage(): JSX.Element {
  const params = useParams();
  return <Show when={(params.id ?? "").startsWith("output-")} keyed fallback={<ArtifactDetailPage />}><NamedOutputPage /></Show>;
}
