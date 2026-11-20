from django.urls import path
from routing.views import heatmap, plan_route

urlpatterns = [
    path("api/plan-route/", plan_route),
    path("api/heatmap/", heatmap),
]
