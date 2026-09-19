from fastapi import APIRouter
from ..providers.registry import global_registry

router = APIRouter()

@router.get("/v1/models")
async def list_models():
    models = global_registry.all_models()
    data = [
        {
            "id": m.id,
            "object": "model",
            "owned_by": m.owned_by,
            "provider": m.provider,
            "display": m.display,
            "capabilities": m.capabilities,
            "context": m.context,
        }
        for m in models
    ]
    # Sort by provider then id
    data.sort(key=lambda x: (x["provider"], x["id"]))
    return {"object": "list", "data": data, "count": len(data)}

@router.get("/models")
async def list_models_alias():
    return await list_models()
