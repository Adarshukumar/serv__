from fastapi import APIRouter
from ..providers.registry import global_registry

router = APIRouter()

@router.get("/v1/providers")
async def list_providers():
    providers = global_registry.all_providers()
    data = []
    for p in providers:
        data.append({
            "name": p.name,
            "display": p.display,
            "models_count": len(p.models),
            "models": p.models[:50],
            "capabilities": p.capabilities,
            "requires_network": p.requires_network,
            "concurrency": p.concurrency,
        })
    data.sort(key=lambda x: (0 if x["capabilities"].get("always_works") else 1, x["name"]))
    return {"object": "list", "data": data, "count": len(data)}
