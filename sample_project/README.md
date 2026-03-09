## Features
- Basic arithmetic operations: addition, subtraction, multiplication, division, power, and modulo.
- Input validation to ensure numbers are entered.
- Result formatting to return integers if possible, otherwise rounded to 6 decimal places.
- History logging to keep track of operations performed.

## Installation
1. Clone the repository:
    ```bash
    git clone https://github.com/your-repo/simple-calculator.git
    ```
2. Navigate to the project directory:
    ```bash
    cd simple-calculator
    ```
3. Install the required dependencies (if any):
    ```bash
    pip install -r requirements.txt
    ```

## Usage
To use the calculator, run the main script:
```bash
python main.py
```
Follow the on-screen prompts to perform calculations. Type `exit` to quit the program.

## Functions
### `utils.py`
- `is_number(value)` 
  - Parameters: `value` (str)
  - Return: `bool` - Returns `True` if the value is a number, otherwise `False`.
- `format_result(result)` 
  - Parameters: `result` (float)
  - Return: `int` or `float` - Returns the result as an integer if it is a whole number, otherwise rounded to 6 decimal places.
- `history_log(operation, result, history=[])` 
  - Parameters: `operation` (str), `result` (float), `history` (list)
  - Return: `list` - Appends the operation and result to the history list and returns the updated list.

### `main.py`
- `run()`
  - Parameters: None
  - Return: None - Runs the calculator program, taking user input for operations and displaying results.

## Examples
### Checking if a value is a number
```py
from utils import is_number

print(is_number("123"))  # True
print(is_number("abc"))  # False
```

### Formatting a result
```py
from utils import format_result

print(format_result(10))  # 10
print(format_result(10.123456789))  # 10.123457
```

### Logging history
```py
from utils import history_log

history = []
history = history_log("+", 5, history)
history = history_log("*", 10, history)
print(history)  # ['+ = 5', '* = 10']
```

## Contributing
1. Fork the repository.
2. Create a new branch for your feature or bug fix:
    ```bash
    git checkout -b feature/your-feature-name
    ```
3. Make your changes and commit them:
    ```bash
    git commit -m "Add a descriptive message"
    ```
4. Push to the branch:
    ```bash
    git push origin feature/your-feature-name
    ```
5. Create a Pull Request.