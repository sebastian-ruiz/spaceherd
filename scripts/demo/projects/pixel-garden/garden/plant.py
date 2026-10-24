from dataclasses import dataclass, field

from .weather import Weather

STAGES = ["seed", "sprout", "bud", "flower"]
SPRITES = {"seed": ".", "sprout": ",", "bud": "i", "flower": "*"}


@dataclass
class Plant:
    x: int
    y: int
    growth: float = 0.0
    history: list[str] = field(default_factory=list)

    @property
    def stage(self) -> str:
        return STAGES[min(int(self.growth), len(STAGES) - 1)]

    @property
    def sprite(self) -> str:
        return SPRITES[self.stage]

    def grow(self, weather: Weather) -> None:
        rate = 0.05 * weather.sunlight
        rate *= 1.5 if weather.raining else 1.0
        self.growth += rate
        self.history.append(self.stage)
