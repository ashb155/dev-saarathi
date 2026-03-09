from calculator import add, subtract, multiply, divide
from utils import format_result, history_log

def run():
    print("=== Simple Calculator ===")
    print("Operations: +, -, *, /") # Fixed operations list
    print("Type 'exit' to quit\n")
    
    session_history = [] # Added to keep track of history

    while True:
        try:
            a = input("Enter first number: ")
            if a.lower() == 'exit':
                break
            op = input("Enter operator (+, -, *, /): ")
            b = input("Enter second number: ")

            a, b = float(a), float(b)

            if op == '+':
                result = add(a, b)
            elif op == '-':
                result = subtract(a, b)
            elif op == '*':
                result = multiply(a, b)
            elif op == '/':
                result = divide(a, b)
            else:
                print("Invalid operator")
                continue

            formatted_result = format_result(result)
            print(f"Result: {formatted_result}")
            
            # Formatted the operation string to match utils.py
            operation_string = f"{a} {op} {b}"
            history_log(operation_string, formatted_result, session_history)

        except ValueError:
            print("Invalid input. Please enter numeric values.")
        except ZeroDivisionError:
            print("Cannot divide by zero.")

if __name__ == "__main__":
    run()