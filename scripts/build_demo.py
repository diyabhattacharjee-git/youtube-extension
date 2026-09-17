"""
Builds the bundled demo mindmap (an ILLUSTRATIVE sample lecture, not a real video).

    python scripts/build_demo.py

Writes:
    examples/sample-lecture-mindmap.json
    extension/viewer/demo/sample-map.json

It doubles as documentation of the mindmap JSON schema produced by the backend
(`backend/app/pipeline/builder.py`): root -> sections -> concepts -> details -> transcript leaves,
each node with `start` seconds for timestamp navigation and a semantic `layer`.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# (title, start, tone, summary, [ (concept, start, detail, [ (child, start) ], quote) ])
OUTLINE = [
    ("Neurons & Layers", 0, ["instructional"], "Networks are stacks of simple units that weigh evidence and pass it on.", [
        ("Artificial neuron: weighted sum of inputs passed through an activation", 42, "Each neuron multiplies inputs by weights, adds a bias and squashes the result.",
         [("Weights scale how much each input matters", 70), ("Bias shifts the activation threshold", 95)],
         "Think of a neuron as a tiny voting machine where every input gets a different number of votes."),
        ("Activation functions: add non-linearity (ReLU, sigmoid, tanh)", 140, "Non-linear activations let networks model curved decision boundaries.",
         [("Without them, stacked layers collapse into one linear map", 175)],
         "If you remove the activation, ten layers are mathematically no better than one."),
        ("Layers: input → hidden → output", 220, "Depth lets networks build features from simple edges to abstract ideas.",
         [("Early layers detect simple patterns, later layers combine them", 255)],
         "The first layer might see edges, the next sees shapes, and deeper layers see whole objects."),
    ]),
    ("Forward Pass & Loss", 300, ["analytical"], "A prediction is produced, then scored by a loss function.", [
        ("Forward pass: data flows layer by layer to a prediction", 320, "Inputs are transformed by each layer until the output layer produces a guess.",
         [("Output layer size matches the number of classes", 350)],
         "The forward pass is just the network making its best guess with the weights it currently has."),
        ("Loss function: one number measuring how wrong the prediction is", 365, "Training means making this number smaller on average.",
         [("Cross-entropy for classification", 400), ("Mean squared error for regression", 425)],
         "Everything in training exists to push this single number down."),
    ]),
    ("Gradient Descent", 480, ["enthusiastic", "instructional"], "Weights move a small step downhill on the loss surface, over and over.", [
        ("Gradient: direction of steepest increase of the loss", 510, "Stepping against the gradient reduces the loss fastest locally.",
         [("Imagine walking downhill in fog, feeling the slope under your feet", 545)],
         "This is honestly one of the most beautiful ideas in all of machine learning!"),
        ("Learning rate: step size for each weight update", 580, "The single most important hyper-parameter to tune.",
         [("Too large overshoots the minimum", 605), ("Too small crawls and wastes compute", 620)],
         "Be careful: a learning rate that is too high can make the loss explode."),
        ("Mini-batches: estimate the gradient on small samples", 660, "Noisy but cheap gradient estimates that also help generalization.",
         [("One pass over the whole dataset is called an epoch", 690)],
         "Instead of looking at all million examples, we look at a batch of sixty-four."),
    ]),
    ("Backpropagation", 720, ["analytical"], "The chain rule tells every weight how it contributed to the error.", [
        ("Backpropagation: chain rule applied from output back to input", 745, "Gradients are computed layer by layer, reusing intermediate results.",
         [("Automatic differentiation libraries do this for you", 800)],
         "Backprop is just the chain rule from calculus, applied very systematically."),
        ("Vanishing gradients: signals shrink through deep stacks", 850, "Early layers barely learn when gradients get multiplied by small numbers.",
         [("ReLU activations help gradients flow", 890), ("Residual connections add shortcuts for the signal", 905)],
         "This problem stalled deep learning for years, which is a real limitation of naive deep networks."),
    ]),
    ("Overfitting & Regularization", 960, ["cautionary"], "A model can memorize its training data instead of learning the pattern.", [
        ("Overfitting: memorizing training data instead of generalizing", 980, "Training loss keeps falling while validation loss rises.",
         [("More data is the most reliable cure", 1010)],
         "Watch out: a perfect score on training data is a warning sign, not a victory."),
        ("Dropout: randomly silence neurons during training", 1050, "Forces the network to spread knowledge across many units.",
         [("Disabled at inference time", 1080)],
         "Dropout is like making a team practice with random members missing."),
        ("Validation set: an early warning for overfitting", 1120, "Held-out data used to pick hyper-parameters and stop training early.",
         [("Never tune on the test set", 1150)],
         "The validation curve tells you when to stop."),
    ]),
    ("Is Bigger Always Better?", 1200, ["controversial"], "Researchers still debate scale versus architecture and interpretability.", [
        ("Scaling debate: more data & parameters vs. smarter architectures", 1230, "Bigger models keep improving, but at rising cost — critics argue for efficiency.",
         [("Compute and energy costs grow quickly", 1275)],
         "This is a genuinely controversial topic and people disagree strongly."),
        ("Interpretability: why a network decides is still hard to explain", 1330, "Tools like saliency maps offer partial, sometimes misleading explanations.",
         [("Important for medicine, finance and law", 1370)],
         "We can measure what the network does far better than we can explain why."),
    ]),
]

EDGES = [
    ("Loss function", "Gradient:", "is minimized via"),
    ("Backpropagation:", "Gradient:", "computes"),
    ("Activation functions", "Vanishing gradients", "can cause"),
    ("Overfitting", "Scaling debate", "motivates"),
]


def node(nid: str, text: str, type_: str, layer: int, start=None, end=None, **extra) -> dict:
    base = {"id": nid, "text": text, "type": type_, "layer": layer, "start": start, "end": end, "summary": "", "tone": [], "keywords": [], "notes": "", "links": [], "image": None, "collapsed": False, "children": []}
    base.update(extra)
    return base


def build() -> dict:
    duration = 1440
    root = node("demo-root", "How Neural Networks Learn", "root", 0, 0, duration,
                summary="From single neurons to gradient descent, backpropagation and the open debates about scale.",
                tone=["instructional", "enthusiastic"], keywords=["neuron", "loss", "gradient descent", "backpropagation", "overfitting"])
    transcript = []
    for si, (title, start, tone, summary, concepts) in enumerate(OUTLINE):
        end = OUTLINE[si + 1][1] if si + 1 < len(OUTLINE) else duration
        section = node(f"demo-s{si + 1}", title, "section", 1, start, end, summary=summary, tone=tone, color=si % 5)
        for ci, (label, cstart, detail, children, quote) in enumerate(concepts):
            concept = node(f"demo-s{si + 1}-c{ci + 1}", label, "concept", 2, cstart, None, summary=detail)
            for di, (child, dstart) in enumerate(children):
                concept["children"].append(node(f"demo-s{si + 1}-c{ci + 1}-d{di + 1}", child, "detail", 3, dstart))
                transcript.append({"start": dstart, "end": dstart + 8, "text": child + "."})
            concept["children"].append(node(f"demo-s{si + 1}-c{ci + 1}-t1", f"“{quote}”", "transcript", 4, cstart + 6, cstart + 14))
            transcript.append({"start": cstart, "end": cstart + 6, "text": detail})
            transcript.append({"start": cstart + 6, "end": cstart + 14, "text": quote})
            section["children"].append(concept)
        root["children"].append(section)

    concepts = [c for s in root["children"] for c in s["children"]]
    edges = []
    for i, (a, b, label) in enumerate(EDGES):
        src = next(c for c in concepts if c["text"].startswith(a))
        dst = next(c for c in concepts if c["text"].startswith(b))
        edges.append({"id": f"demo-e{i + 1}", "source": src["id"], "target": dst["id"], "label": label, "origin": "sample"})

    root["children"][0]["notes"] = "Try it: click ▶ chips, press 1–4 to switch semantic layers, right-click for AI actions, or open 🎓 Study."
    root["children"][0]["links"] = [{"title": "Neural network (Wikipedia)", "url": "https://en.wikipedia.org/wiki/Neural_network_(machine_learning)"}]

    return {
        "schema": "tubemind/1",
        "id": "demo-neural-networks",
        "version": 1,
        "meta": {
            "title": "Sample: How Neural Networks Learn (illustrative lecture)",
            "videoId": None,
            "channel": "TubeMind sample",
            "duration": duration,
            "mode": "academic",
            "profile": "balanced",
            "language": "en",
            "transcriptSource": "sample",
            "llm": "hand-written sample",
            "embeddings": "n/a",
            "createdAt": int(time.time() * 1000),
            "sample": True,
            "note": "Illustrative data bundled with TubeMind. It is not linked to a real video, so ▶ timestamps show a notice instead of seeking.",
        },
        "root": root,
        "edges": edges,
        "segments": [{"id": s["id"], "start": s["start"], "end": s["end"], "title": s["text"]} for s in root["children"]],
        "transcript": sorted(transcript, key=lambda e: e["start"]),
    }


def main() -> None:
    data = build()
    for target in (ROOT / "examples" / "sample-lecture-mindmap.json", ROOT / "extension" / "viewer" / "demo" / "sample-map.json"):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        print("wrote", target.relative_to(ROOT))


if __name__ == "__main__":
    main()
